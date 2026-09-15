import 'dotenv/config';
import express from "express";
import compression from "compression";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import os from "os";
import { PDFDocument } from "pdf-lib";
import Database from "better-sqlite3";
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from "crypto";

const hashDeleteToken = (token) => createHash("sha256").update(String(token)).digest("hex");

import db, { getSettings, updateSetting, getInternalState, setInternalState, getPaperTypes, replaceAllPaperTypes, createPaperType, updatePaperType, deletePaperType, getDiscountRules, getActiveDiscountRules, createDiscountRule, updateDiscountRule, deleteDiscountRule, reopenDb, checkpointAndClose, INVENTORY_CATEGORIES, getInventoryItems, getInventoryItem, createInventoryItem, updateInventoryItem, deleteInventoryItem, adjustInventoryStock, getInventoryAdjustments, getInventoryItemsByPaperType, getLowStockCount, hasAutoDeductForJob } from './db.js';
import { ALLOWED_MIMES, magicBytesMatch } from '@localprint/shared/validation';
import { makeRateLimiter, securityHeaders } from '@localprint/shared/http';
import { pruneTokenMap } from './utils/adminTokens.js';

// ── File magic-byte validation ──
// Signatures + the pure matcher live in @localprint/shared/validation
// (importable + tested); this wrapper does the disk read the server needs.
function validateMagicBytes(filePath, mimeType) {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  return magicBytesMatch(buf, mimeType);
}

// ── Settings exposure control ──
// Keys the UNAUTHENTICATED public upload page is allowed to read. Anything not
// listed here (secrets, cloud credentials, internal state) never leaves the
// server on the public endpoint.
const PUBLIC_SETTINGS_KEYS = new Set([
  "shopName", "logoUrl", "pricing", "discounts",
  "phoneNumbers", "email", "address", "workingHours", "returnPolicy",
  "currency",
  // Public storefront link — the customer share sheet builds its QR from these.
  // Both are already public information (the site URL and its slug).
  "cloudSyncUrl", "cloudShopSlug",
]);

// Keys that must NEVER be serialized into any HTTP response, even for admins.
const SECRET_SETTINGS_KEYS = new Set([
  "gmailTokens", "gmailToken",
]);

// ── Cloud link parsing ──
// Operators hand out ONE link per store: https://cloud.example.com/s/<slug>
// (with or without a trailing /upload and query). The desktop app talks to the
// platform root, so split that link into the API base URL and the storefront
// slug. A bare root URL is accepted too — the slug then arrives on the first
// settings sync.
function parseCloudLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return { baseUrl: '', slug: '' };
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { baseUrl: text.replace(/\/+$/, ''), slug: '' };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.indexOf('s');
  let slug = '';
  if (marker !== -1 && segments[marker + 1]) {
    slug = decodeURIComponent(segments[marker + 1]);
    segments.length = marker; // everything before /s/<slug> stays in the base
  }
  const basePath = segments.length ? `/${segments.join('/')}` : '';
  return { baseUrl: `${url.origin}${basePath}`, slug };
}

function pickPublicSettings(settings) {
  const out = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

function stripSecretSettings(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_SETTINGS_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// ── Auth token management (persisted in DB) ──
// Each token is { token, createdAt, lastUsedAt }. A token dies once it has been
// idle past TOKEN_IDLE_MS or once it is older than TOKEN_ABSOLUTE_MS, whichever
// comes first. Expired tokens are pruned on every check and on a timer.
const TOKEN_IDLE_MS = Number(process.env.ADMIN_TOKEN_IDLE_DAYS || 14) * 86_400_000;
const TOKEN_ABSOLUTE_MS = Number(process.env.ADMIN_TOKEN_MAX_DAYS || 30) * 86_400_000;

function loadTokens() {
  try {
    const parsed = getInternalState('_admin_tokens');
    if (!parsed) return new Map();
    const map = new Map();
    if (Array.isArray(parsed)) {
      const now = Date.now();
      for (const entry of parsed) {
        if (typeof entry === "string") {
          // legacy: bare token string, no timestamps — treat as fresh once
          map.set(entry, { token: entry, createdAt: now, lastUsedAt: now });
        } else if (entry && entry.token) {
          map.set(entry.token, {
            token: entry.token,
            createdAt: entry.createdAt || now,
            lastUsedAt: entry.lastUsedAt || entry.createdAt || now,
          });
        }
      }
    }
    return map;
  } catch { return new Map(); }
}

function saveTokens(tokens) {
  setInternalState('_admin_tokens', [...tokens.values()]);
}

const adminTokens = loadTokens();

function pruneTokens() {
  const { changed } = pruneTokenMap(adminTokens, Date.now(), TOKEN_IDLE_MS, TOKEN_ABSOLUTE_MS);
  if (changed) saveTokens(adminTokens);
}

// Prune stale tokens hourly.
setInterval(pruneTokens, 3_600_000);
pruneTokens();

function generateToken() {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  adminTokens.set(token, { token, createdAt: now, lastUsedAt: now });
  saveTokens(adminTokens);
  return token;
}

// Returns the token string if valid (and bumps lastUsedAt), else null.
function validAdminToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  pruneTokens();
  const meta = adminTokens.get(token);
  if (!meta) return null;
  meta.lastUsedAt = Date.now();
  // Persist the touch lazily — a write per request is wasteful; the hourly
  // prune and login/logout writes are enough to survive a restart.
  return token;
}

function isValidAdminToken(req) {
  return validAdminToken(req) !== null;
}

// True while the admin password is still the factory default.
let mustChangePassword = false;

// Middleware: require valid admin token
function requireAdmin(req, res, next) {
  const token = validAdminToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.adminToken = token;
  // While the password is still the default, the only things the operator may
  // do are change it or log out.
  if (mustChangePassword) {
    const allowed = ["/api/settings/password", "/api/auth/logout"];
    if (!allowed.includes(req.path)) {
      return res.status(403).json({ error: "Password change required", mustChangePassword: true });
    }
  }
  next();
}

// ── Generic sliding-window limiter factory (per-IP) ──
// Imported from @localprint/shared/http (shared with the online app).

// Public upload: 30 files / 5 min / IP is generous for a walk-in customer but
// caps disk-fill / job-spam from the LAN.
const uploadLimit = makeRateLimiter({ windowMs: 300_000, max: 30, message: "Upload limit reached. Please wait a few minutes." });

// ── Login lockout (per-IP, counts FAILED /api/auth/verify attempts only) ──
// 5 fails → locked 1 min, 10 fails → locked 15 min. A success clears the count.
const loginFailMap = new Map(); // ip -> { count, lockedUntil }
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

function loginGuard(req, res, next) {
  const rec = loginFailMap.get(clientIp(req));
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const retryMs = rec.lockedUntil - Date.now();
    res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    return res.status(429).json({ error: "Too many failed attempts. Try again later.", retryMs });
  }
  next();
}

function recordLoginFailure(req) {
  const ip = clientIp(req);
  const rec = loginFailMap.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 10) rec.lockedUntil = Date.now() + 15 * 60_000;
  else if (rec.count >= 5) rec.lockedUntil = Date.now() + 60_000;
  loginFailMap.set(ip, rec);
  if (rec.lockedUntil > Date.now()) {
    console.warn(`🔒 Login lockout for ${ip} (${rec.count} failed attempts) until ${new Date(rec.lockedUntil).toISOString()}`);
  }
}

function clearLoginFailures(req) {
  loginFailMap.delete(clientIp(req));
}

// Drop lockout records once they have fully expired.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginFailMap) {
    if ((!rec.lockedUntil || rec.lockedUntil < now) && now - (rec.lockedUntil || 0) > 3_600_000) {
      loginFailMap.delete(ip);
    }
  }
}, 600_000);

// ── Allowed MIME types for upload ──
// ALLOWED_MIMES is imported from @localprint/shared/validation (shared with the
// magic-byte matcher and covered by the validation test suite).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment configuration
const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV === "development";
const PORT = process.env.PORT || (isDev ? 3001 : 3000);

// Path configuration
// PRINTSHOP_UPLOADS_DIR / PRINTSHOP_DB_PATH are set by the Electron main
// process for packaged builds (so runtime data lives under userData, not
// Program Files). Fall back to repo-relative paths for `npm run dev`.
const DIST_DIR = path.join(__dirname, "dist");
const UPLOADS_DIR = process.env.PRINTSHOP_UPLOADS_DIR || path.join(__dirname, "uploads");
const DB_PATH = process.env.PRINTSHOP_DB_PATH || path.join(__dirname, "database.sqlite");

const app = express();

// gzip everything text-shaped. The JSON job list and the JS bundle are the two
// biggest payloads the dashboard waits on. SSE is excluded — buffering the
// event stream would hold job notifications back until the connection closed.
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type") || "");
      if (type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

// Middleware — cap body sizes; uploads go through multer, not these.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// CORS for development only (allow the Vite dev server on its own port).
// Never enabled in a packaged build.
// Vite dev server runs on :3000 and proxies /api to this server on :3001.
const DEV_ORIGIN = process.env.DEV_CORS_ORIGIN || "http://localhost:3000";
if (isDev) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", DEV_ORIGIN);
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}

// Security headers middleware — static headers + the pdf.js-compatible CSP.
// Shared with the online app; see @localprint/shared/http for the CSP rationale.
app.use(securityHeaders());

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DIST_DIR) && !isDev) {
  console.warn("⚠️  DIST_DIR does not exist. Run build first!");
}

/**
 * PDF Page Count Helper — uses pdf-lib for accurate counting.
 */

/**
 * PDF Page Count Helper — uses pdf-lib for accurate counting.
 * Handles encrypted and malformed PDFs gracefully.
 *
 * @param {string} filePath - Absolute path to the PDF file on disk.
 * @returns {Promise<number|null>} Page count, or null if the file cannot be read.
 */
const getPdfPageCount = async (filePath) => {
  try {
    const fileBuffer = fs.readFileSync(filePath);

    // ignoreEncryption: true  — prevents a crash on password-protected PDFs
    //   (page count is still readable even for encrypted docs)
    // updateMetadata: false   — skip rewriting metadata; we only need page count
    const pdfDoc = await PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    const pageCount = pdfDoc.getPageCount();
    console.log(
      `📄 PDF page count for ${path.basename(filePath)}: ${pageCount}`,
    );
    return pageCount;
  } catch (err) {
    console.error(
      `❌ Error reading PDF page count for ${path.basename(filePath)}:`,
      err.message,
    );
    return null;
  }
};

/**
 * Page count for any supported upload, computed server-side so the admin list
 * never has to download files to work it out.
 *
 * @param {string} filePath - Absolute path to the stored file.
 * @param {string} mimeType - Claimed MIME type (already magic-byte validated).
 * @param {number} fileSize - Size in bytes, used by the size heuristics.
 * @returns {Promise<number|null>} Page count, or null if it cannot be derived.
 */
const computePageCount = async (filePath, mimeType, fileSize) => {
  const type = String(mimeType || "").toLowerCase();

  if (type.includes("pdf")) return await getPdfPageCount(filePath);
  if (type.startsWith("image/")) return 1;

  const size = Number(fileSize) || (() => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  })();

  if (type.includes("word") || type.includes("document")) {
    // DOCX is a ZIP; docProps/app.xml carries <Pages>N</Pages> uncompressed
    // often enough to be worth a scan before falling back to the size estimate.
    try {
      const bytes = fs.readFileSync(filePath);
      const match = bytes.toString("latin1").match(/<Pages>(\d+)<\/Pages>/);
      if (match) return Math.max(1, parseInt(match[1], 10));
    } catch (err) {
      console.warn(`⚠️  Could not scan ${path.basename(filePath)} for a page count:`, err.message);
    }
    // ~40KB of container overhead, then ~8KB per page of text.
    return Math.max(1, Math.round((size - 40000) / 8000));
  }

  return Math.max(1, Math.ceil(size / 75000));
};

// Backfill missing pageCount for existing jobs (runs once at startup)
const backfillPageCounts = async () => {
  const jobsMissingCount = db.prepare(`
    SELECT * FROM jobs
    WHERE pageCount IS NULL OR pageCount = 0
  `).all();

  if (jobsMissingCount.length === 0) {
    console.log("✅ All jobs already have page counts.");
    return;
  }

  console.log(
    `📚 Backfilling page counts for ${jobsMissingCount.length} job(s)...`,
  );

  const updateStmt = db.prepare('UPDATE jobs SET pageCount = ? WHERE id = ?');

  for (const job of jobsMissingCount) {
    if (!job.serverFileName) {
      console.warn(`  ⚠️  Job ${job.id} has no serverFileName — skipping.`);
      continue;
    }
    const filePath = path.join(UPLOADS_DIR, job.serverFileName);
    if (fs.existsSync(filePath)) {
      const count = await computePageCount(filePath, job.fileType, job.fileSize);
      if (count !== null) {
        updateStmt.run(count, job.id);
        console.log(`  ✅ ${job.fileName}: ${count} page(s)`);
      } else {
        console.warn(
          `  ⚠️  Could not count pages for ${job.fileName} — file may be corrupted.`,
        );
      }
    } else {
      console.warn(
        `  ⚠️  File not found for job ${job.id}`,
      );
    }
  }
};

// Run backfill (non-blocking — won't block server startup)
backfillPageCounts().catch((err) => console.error("❌ Backfill error:", err));

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const randomName = randomBytes(16).toString("hex");
    cb(null, randomName + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Allowed: PDF, DOCX, XLSX, JPEG, PNG, TIFF`));
    }
  },
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * API ROUTES
 */

// Favicon — inline SVG to avoid 404
app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#2563eb"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">P</text></svg>`);
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Get all jobs (admin only)
// Newest-first page of jobs. The dashboard filters and counts client-side, so
// it asks for a generous page and only fetches the rest when the operator asks
// — an unbounded SELECT here is what made the list crawl on old shop databases.
const JOBS_PAGE_DEFAULT = 500;
const JOBS_PAGE_MAX = 5000;

app.get("/api/jobs", requireAdmin, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), JOBS_PAGE_MAX)
    : JOBS_PAGE_DEFAULT;
  const rawOffset = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const total = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
  const page = db
    .prepare('SELECT * FROM jobs ORDER BY uploadDate DESC LIMIT ? OFFSET ?')
    .all(limit, offset);

  // The review queue lives in this same payload, so a job awaiting review must
  // never fall off the end of a page — always append the ones the page missed.
  const seen = new Set(page.map((j) => j.id));
  const pendingReview = db
    .prepare("SELECT * FROM jobs WHERE status = 'pending_review' ORDER BY uploadDate DESC")
    .all()
    .filter((j) => !seen.has(j.id));
  const jobs = page.concat(pendingReview);

  res.set("X-Total-Count", String(total));
  res.set("Access-Control-Expose-Headers", "X-Total-Count");
  const formattedJobs = jobs.map(job => ({
    ...job,
    paymentAmount: job.paymentAmount || 0,
    paymentStatus: job.paymentStatus || 'UNPAID',
    printPreferences: {
      colorMode: job.colorMode,
      copies: job.copies,
      paperType: job.paperType || 'normal'
    }
  }));
  res.status(200).json(formattedJobs);
});

// Public query — get jobs by ID array (for "my recent uploads")
app.post("/api/jobs/query", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(200).json([]);
  }
  const placeholders = ids.map(() => '?').join(',');
  const jobs = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders}) ORDER BY uploadDate DESC`).all(...ids);
  const sanitized = jobs.map(job => ({
    id: job.id,
    fileName: job.fileName,
    fileType: job.fileType,
    fileSize: job.fileSize,
    uploadDate: job.uploadDate,
    status: job.status,
    pageCount: job.pageCount,
    paperType: job.paperType || 'normal',
    colorMode: job.colorMode,
    copies: job.copies,
    source: job.source,
    paymentStatus: job.paymentStatus || 'UNPAID',
    paymentAmount: job.paymentAmount || 0,
    printPreferences: {
      colorMode: job.colorMode,
      copies: job.copies,
      paperType: job.paperType || 'normal'
    },
  }));
  res.status(200).json(sanitized);
});

// Upload new job
app.post("/api/upload", uploadLimit, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }

    const metadata = JSON.parse(req.body.metadata || "{}");
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

    // Validate magic bytes match the claimed MIME type
    if (!validateMagicBytes(filePath, req.file.mimetype)) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: "File content does not match its type" });
    }

    const pageCount = await computePageCount(filePath, req.file.mimetype, req.file.size);

    // The server owns the primary key and the delete secret — never the client.
    const id = randomUUID();
    const deleteToken = randomBytes(16).toString("hex");
    const prefs = metadata.printPreferences || {};

    const newJob = {
      id,
      customerName: String(metadata.customerName || metadata.customer || "").trim(),
      phoneNumber: String(metadata.phoneNumber || metadata.phone || "").trim(),
      notes: String(metadata.notes || "").trim(),
      fileName: String(metadata.fileName || req.file.originalname || "upload").trim(),
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      uploadDate: new Date().toISOString(),
      status: metadata.status || "PENDING",
      serverFileName: req.file.filename,
      pageCount,
      colorMode: prefs.colorMode || metadata.colorMode || "color",
      copies: Number(prefs.copies || metadata.copies) >= 1 ? Math.floor(Number(prefs.copies || metadata.copies)) : 1,
      paperType: prefs.paperType || metadata.paperType || "normal",
      source: metadata.source || "upload",
    };

    const insertStmt = db.prepare(`
      INSERT INTO jobs (
        id, customerName, phoneNumber, notes, fileName, fileType,
        fileSize, uploadDate, status, serverFileName, pageCount,
        colorMode, copies, paperType, source, deleteTokenHash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      newJob.id, newJob.customerName, newJob.phoneNumber, newJob.notes,
      newJob.fileName, newJob.fileType, newJob.fileSize, newJob.uploadDate,
      newJob.status, newJob.serverFileName, newJob.pageCount,
      newJob.colorMode, newJob.copies, newJob.paperType, newJob.source,
      hashDeleteToken(deleteToken)
    );

    broadcastEvent("new-job", { id: newJob.id });
    // deleteToken is returned exactly once — the client keeps it in localStorage.
    res.status(200).json({
      success: true,
      job: { ...newJob, printPreferences: { colorMode: newJob.colorMode, copies: newJob.copies, paperType: newJob.paperType } },
      deleteToken,
    });
  } catch (err) {
    console.error("❌ Upload Error:", err);
    res.status(400).json({ success: false, error: "Invalid upload metadata" });
  }
});

// Admin job create — operator-made jobs (Photo Batch save-as-job, manual job
// entry). Authenticated, unlike the public /api/upload. The server owns the id;
// any client-supplied id is ignored. These jobs are local-only (source: "admin"),
// so cloudSync never touches them.
app.post("/api/jobs", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const metadata = JSON.parse(req.body.metadata || "{}");
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

    // Magic bytes must match the claimed MIME type (validated against the
    // shared allowlist — PDF, JPEG, PNG, TIFF, DOCX, XLSX).
    if (!validateMagicBytes(filePath, req.file.mimetype)) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: "File content does not match its type" });
    }

    const pageCount = await computePageCount(filePath, req.file.mimetype, req.file.size);

    const id = randomUUID();
    const deleteToken = randomBytes(16).toString("hex");
    const prefs = metadata.printPreferences || {};

    const colorMode = prefs.colorMode === "blackWhite" ? "blackWhite" : "color";
    const copies = Number(prefs.copies) >= 1 ? Math.floor(Number(prefs.copies)) : 1;
    const paperType = String(prefs.paperType || "normal");
    const uploadDate = new Date().toISOString();

    const newJob = {
      id,
      customerName: String(metadata.customerName || metadata.customer || "").trim(),
      phoneNumber: String(metadata.phoneNumber || metadata.phone || "").trim(),
      notes: String(metadata.notes || "").trim(),
      fileName: String(metadata.fileName || req.file.originalname || "upload").trim(),
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      uploadDate,
      status: "PENDING",
      serverFileName: req.file.filename,
      pageCount,
      colorMode,
      copies,
      paperType,
      source: "admin",
    };

    const insertStmt = db.prepare(`
      INSERT INTO jobs (
        id, customerName, phoneNumber, notes, fileName, fileType,
        fileSize, uploadDate, status, serverFileName, pageCount,
        colorMode, copies, paperType, source, deleteTokenHash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      newJob.id, newJob.customerName, newJob.phoneNumber, newJob.notes,
      newJob.fileName, newJob.fileType, newJob.fileSize, newJob.uploadDate,
      newJob.status, newJob.serverFileName, newJob.pageCount,
      newJob.colorMode, newJob.copies, newJob.paperType, newJob.source,
      hashDeleteToken(deleteToken)
    );

    broadcastEvent("new-job", { id: newJob.id });
    res.status(200).json({
      success: true,
      job: { ...newJob, printPreferences: { colorMode: newJob.colorMode, copies: newJob.copies, paperType: newJob.paperType } },
      deleteToken,
    });
  } catch (err) {
    console.error("❌ Admin job create error:", err);
    res.status(400).json({ success: false, error: "Invalid job metadata" });
  }
});

// Update job file
app.post("/api/jobs/:id/file", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const jobId = req.params.id;
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }

    // Validate magic bytes match the claimed MIME type
    const newFilePath = path.join(UPLOADS_DIR, req.file.filename);
    if (!validateMagicBytes(newFilePath, req.file.mimetype)) {
      fs.unlinkSync(newFilePath);
      return res.status(400).json({ success: false, error: "File content does not match its type" });
    }

    // Delete old file
    if (job.serverFileName) {
      const oldPath = path.join(UPLOADS_DIR, job.serverFileName);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (e) {
          console.warn("⚠️  Could not delete old file");
        }
      }
    }

    const pageCount = await computePageCount(
      path.join(UPLOADS_DIR, req.file.filename),
      req.file.mimetype,
      req.file.size,
    );

    // Optional display-name update — a job whose image was replaced by a
    // processed PDF must not keep advertising the old "photo.jpg".
    const rawName = typeof req.body?.fileName === "string" ? req.body.fileName.trim() : "";
    const newFileName = rawName ? path.basename(rawName).slice(0, 255) : job.fileName;

    // Update job in DB
    const updateStmt = db.prepare(`
      UPDATE jobs
      SET serverFileName = ?, fileName = ?, fileSize = ?, fileType = ?, pageCount = ?
      WHERE id = ?
    `);
    updateStmt.run(req.file.filename, newFileName, req.file.size, req.file.mimetype, pageCount, jobId);

    const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    res.status(200).json({ success: true, job: updatedJob });
  } catch (err) {
    console.error("❌ Update File Error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Update job status
app.put("/api/jobs/:id/status", requireAdmin, (req, res) => {
  const { status } = req.body;
  const jobId = req.params.id;

  const previousStatus = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status;
  const result = db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);

  if (result.changes > 0) {
    const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    applyAutoDeductForJob(updatedJob, previousStatus);
    res.status(200).json({ success: true, job: updatedJob });

    // Push to the cloud so the customer's upload page reflects the change
    // via the SSE stream. Fire-and-forget — no need to block the response.
    const cloudOrderId = updatedJob?.cloudOrderId;
    if (cloudOrderId) {
      import('./services/cloudSync.js').then(({ updateCloudStatus, isEnabled }) => {
        if (isEnabled()) {
          updateCloudStatus(cloudOrderId, status).catch(err => warnCloudSyncFailed(1, err));
        }
      }).catch(err => warnCloudSyncFailed(1, err));
    }

    // Auto-notify the customer when a gmail-sourced job becomes READY.
    // Idempotent via notifiedReadyAt — safe if the admin toggles status.
    if (
      status === "READY" &&
      previousStatus !== "READY" &&
      updatedJob?.source === "gmail" &&
      updatedJob?.gmailMessageId &&
      !updatedJob?.notifiedReadyAt
    ) {
      import('./services/gmailNotifier.js')
        .then(({ sendJobReadyNotification }) => sendJobReadyNotification(jobId))
        .then((r) => {
          if (r.sent) console.log(`  📧 Ready notification sent for job ${jobId}`);
          else if (r.reason !== "already_notified") console.warn(`⚠️  Ready notification skipped for ${jobId}: ${r.reason}`);
        })
        .catch((err) => console.warn(`⚠️  Ready notification failed for ${jobId}:`, err.message));
    }
  } else {
    res.status(404).json({ success: false, error: "Job not found" });
  }
});

// Manual re-send of the "ready" notification (admin can force from the UI
// if the automatic send failed or the template was updated afterwards).
app.post("/api/jobs/:id/notify-ready", requireAdmin, async (req, res) => {
  try {
    const { sendJobReadyNotification } = await import('./services/gmailNotifier.js');
    const result = await sendJobReadyNotification(req.params.id, { force: true });
    if (result.sent) return res.json({ success: true });
    res.status(400).json({ success: false, error: result.reason });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update job print preferences (colorMode, copies)
app.put("/api/jobs/:id/preferences", requireAdmin, (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  
  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  const { colorMode, copies, paperType } = req.body;
  let finalColorMode = job.colorMode;
  let finalCopies = job.copies;
  let finalPaperType = job.paperType || 'normal';

  if (colorMode === "color" || colorMode === "blackWhite") {
    finalColorMode = colorMode;
  }

  const parsedCopies = parseInt(copies, 10);
  if (!isNaN(parsedCopies) && parsedCopies >= 1 && parsedCopies <= 100) {
    finalCopies = parsedCopies;
  }

  if (paperType && typeof paperType === 'string') {
    finalPaperType = paperType;
  }

  db.prepare('UPDATE jobs SET colorMode = ?, copies = ?, paperType = ? WHERE id = ?')
    .run(finalColorMode, finalCopies, finalPaperType, jobId);

  const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  console.log(
    `✏️  Updated preferences for job ${jobId}: ${finalColorMode}, ${finalCopies} cop(ies)`,
  );
  res.status(200).json({ 
    success: true, 
    job: {
      ...updatedJob,
      printPreferences: { colorMode: finalColorMode, copies: finalCopies, paperType: finalPaperType }
    } 
  });
});

// Delete job — customer proves ownership with the per-upload deleteToken
// (handed back once at upload time). Admin token also works.
app.delete("/api/jobs/:id", (req, res) => {
  const jobId = req.params.id;
  const { deleteToken } = req.body || {};

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  const isAdmin = isValidAdminToken(req);
  const tokenOk = job.deleteTokenHash && deleteToken &&
    hashDeleteToken(deleteToken) === job.deleteTokenHash;
  if (!isAdmin && !tokenOk) {
    return res.status(403).json({ success: false, error: "Not authorized to delete this job" });
  }

  const filePath = job.serverFileName ? path.join(UPLOADS_DIR, job.serverFileName) : null;
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("⚠️  Could not delete physical file");
  }

  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  broadcastEvent("job-deleted", { id: jobId });
  res.status(200).json({ success: true });
});

// Accept a job awaiting review (cloud-sync jobs held back by auto_accept_cloud_jobs=false)
app.post("/api/jobs/:id/review/accept", requireAdmin, async (req, res) => {
  try {
    const jobId = req.params.id;
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ success: false, error: "Job not found" });
    if (job.status !== 'pending_review') {
      return res.status(400).json({ success: false, error: "Job is not awaiting review" });
    }

    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('PENDING', jobId);

    // Ack on the cloud so it stops showing up in /api/shop/pending. If this
    // fails, the next poll cycle's dedupe check will notice the job is no
    // longer pending_review and retry the ack automatically.
    import('./services/cloudSync.js').then(({ acknowledgeOrder }) => {
      acknowledgeOrder(jobId).catch(err => console.error('❌ Failed to ack accepted review job:', err.message));
    }).catch(() => {});

    const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    broadcastEvent("new-job", { id: jobId });
    res.status(200).json({ success: true, job: updatedJob });
  } catch (err) {
    console.error("❌ Accept review error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Reject a job awaiting review — tells the cloud why, deletes the local file/row
app.post("/api/jobs/:id/review/reject", requireAdmin, async (req, res) => {
  try {
    const jobId = req.params.id;
    const { reason, note } = req.body;
    if (!reason) {
      return res.status(400).json({ success: false, error: "reason is required" });
    }

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return res.status(404).json({ success: false, error: "Job not found" });

    const { rejectCloudOrder } = await import('./services/cloudSync.js');
    const rejected = await rejectCloudOrder(jobId, reason, note);
    if (!rejected) {
      console.warn(`⚠️  Cloud reject failed for ${jobId} — it may reappear for review on the next poll`);
    }

    if (job.serverFileName) {
      const filePath = path.join(UPLOADS_DIR, job.serverFileName);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.warn("⚠️  Could not delete rejected job's file"); }
    }

    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Reject review error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Bulk delete jobs
app.post("/api/jobs/bulk/delete", requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "No IDs provided" });
  }
  const deleteStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const runStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  // Collect file names inside the transaction, unlink AFTER it commits —
  // filesystem ops aren't transactional, so a throw mid-loop would otherwise
  // leave files deleted for rows that got rolled back.
  const filesToDelete = [];
  const txn = db.transaction((jobIds) => {
    for (const id of jobIds) {
      const job = deleteStmt.get(id);
      if (job) {
        if (job.serverFileName) filesToDelete.push(job.serverFileName);
        runStmt.run(id);
      }
    }
  });
  txn(ids);
  for (const name of filesToDelete) {
    const filePath = path.join(UPLOADS_DIR, name);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  }
  res.status(200).json({ success: true, deleted: ids.length });
});

// Bulk status update
app.post("/api/jobs/bulk/status", requireAdmin, (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "No IDs provided" });
  }
  const stmt = db.prepare('UPDATE jobs SET status = ? WHERE id = ?');
  const getStmt = db.prepare('SELECT cloudOrderId FROM jobs WHERE id = ?');
  const jobStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const cloudIds = [];
  // Captured inside the transaction, applied after it commits — stock changes
  // shouldn't ride on the status transaction.
  const deducts = [];
  const txn = db.transaction((jobIds) => {
    for (const id of jobIds) {
      const previousStatus = jobStmt.get(id)?.status;
      stmt.run(status, id);
      const row = getStmt.get(id);
      if (row?.cloudOrderId) cloudIds.push(row.cloudOrderId);
      deducts.push({ job: jobStmt.get(id), previousStatus });
    }
  });
  txn(ids);
  for (const { job, previousStatus } of deducts) applyAutoDeductForJob(job, previousStatus);
  res.status(200).json({ success: true, updated: ids.length });

  // Fire-and-forget cloud sync for each cloud-sourced job
  if (cloudIds.length > 0) {
    import('./services/cloudSync.js').then(({ updateCloudStatus, isEnabled }) => {
      if (!isEnabled()) return;
      for (const cid of cloudIds) {
        updateCloudStatus(cid, status).catch(err => warnCloudSyncFailed(cloudIds.length, err));
      }
    }).catch(err => warnCloudSyncFailed(cloudIds.length, err));
  }
});

// Update payment status for a single job
app.put("/api/jobs/:id/payment", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { paymentStatus, paymentAmount } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });
  const paymentDate = paymentStatus === 'PAID' || paymentStatus === 'PARTIAL' ? new Date().toISOString() : null;
  db.prepare('UPDATE jobs SET paymentStatus = ?, paymentAmount = ?, paymentDate = ? WHERE id = ?').run(paymentStatus, paymentAmount || null, paymentDate, id);
  res.status(200).json({ success: true });
});

// Bulk payment update
app.post("/api/jobs/bulk/payment", requireAdmin, (req, res) => {
  const { ids, paymentStatus } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "No IDs provided" });
  }
  const paymentDate = paymentStatus === 'PAID' || paymentStatus === 'PARTIAL' ? new Date().toISOString() : null;
  const stmt = db.prepare('UPDATE jobs SET paymentStatus = ?, paymentDate = ? WHERE id = ?');
  const txn = db.transaction((jobIds) => {
    for (const id of jobIds) stmt.run(paymentStatus, paymentDate, id);
  });
  txn(ids);
  res.status(200).json({ success: true, updated: ids.length });
});

// Database backup download
app.get("/api/backup/download", requireAdmin, (req, res) => {
  if (!fs.existsSync(DB_PATH)) {
    return res.status(404).json({ success: false, error: "Database not found" });
  }
  res.download(DB_PATH, `printshop-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
});

// Database backup restore
app.post("/api/backup/restore", requireAdmin, uploadMemory.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded" });
  }
  const _dbPath = DB_PATH;
  const _backupPath = _dbPath + '.before_restore';
  const _incomingPath = _dbPath + '.incoming';

  // 1. Write the upload to a scratch file and prove it's a healthy SQLite
  //    database with our schema BEFORE touching the live file. A truncated
  //    upload or a wrong-file paste used to overwrite the DB unconditionally.
  try {
    fs.writeFileSync(_incomingPath, req.file.buffer);
    const probe = new Database(_incomingPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = probe.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
      const hasJobs = probe.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'"
      ).get();
      if (!hasJobs) throw new Error("not a PrintShop backup (no 'jobs' table)");
    } finally {
      probe.close();
    }
  } catch (e) {
    try { fs.unlinkSync(_incomingPath); } catch (e2) {}
    return res.status(400).json({ success: false, error: `Invalid backup file — ${e.message}` });
  }

  // 2. Checkpoint the WAL into the live file, close, swap, reopen.
  checkpointAndClose();
  try {
    if (fs.existsSync(_dbPath)) fs.copyFileSync(_dbPath, _backupPath);
    fs.renameSync(_incomingPath, _dbPath);
    // A fresh restore starts from a clean file — stale WAL/SHM from the old
    // database must not be replayed on top of it.
    for (const ext of ['-wal', '-shm']) {
      try { fs.unlinkSync(_dbPath + ext); } catch (e2) {}
    }
    reopenDb();
    res.status(200).json({ success: true });
  } catch (e) {
    try { if (fs.existsSync(_backupPath)) fs.copyFileSync(_backupPath, _dbPath); } catch (e2) {}
    try { reopenDb(); } catch (e2) {}
    res.status(500).json({ success: false, error: e.message });
  }
});

// Public file access by job ID — anyone with the job ID can download (must be before the admin catch-all)
// Resolve a job to its absolute path on this machine. Admin-only — this
// leaks the local FS layout, so the renderer only calls it inside the
// Electron desktop app to feed the native print IPC. Path-traversal
// protected same way as /api/files/*.
app.get("/api/files/localpath/:id", requireAdmin, (req, res) => {
  try {
    const job = db.prepare('SELECT serverFileName FROM jobs WHERE id = ?').get(req.params.id);
    if (!job || !job.serverFileName) {
      return res.status(404).json({ error: "File not found" });
    }
    const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on disk" });
    }
    res.json({ path: filePath });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin preview/download by job id — unlike /api/files/public/:id this does
// NOT hide jobs awaiting review, because reviewing a job means looking at its
// file before accepting or rejecting it. Admin token required.
app.get("/api/files/review/:id", requireAdmin, (req, res) => {
  try {
    const job = db.prepare('SELECT serverFileName, fileName, fileType FROM jobs WHERE id = ?').get(req.params.id);
    if (!job || !job.serverFileName) {
      return res.status(404).json({ error: "File not found" });
    }
    const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on disk" });
    }
    const safeName = (job.fileName || "file").replace(/[^a-zA-Z0-9._-]/g, '_');
    const inline = /^image\//.test(job.fileType || "") || job.fileType === "application/pdf";
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/files/public/:id", (req, res) => {
  try {
    const job = db.prepare('SELECT serverFileName, fileName, fileType, status FROM jobs WHERE id = ?').get(req.params.id);
    if (!job || !job.serverFileName) {
      return res.status(404).json({ error: "File not found" });
    }
    // Don't serve files for jobs that haven't cleared review or were rejected.
    if (["pending_review", "rejected", "REJECTED"].includes(job.status)) {
      return res.status(404).json({ error: "File not available" });
    }
    const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (fs.existsSync(filePath)) {
      const safeName = (job.fileName || "file").replace(/[^a-zA-Z0-9._-]/g, '_');
      const inline = /^image\//.test(job.fileType || "") || job.fileType === "application/pdf";
      res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`);
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Download/view file by server file name (admin only — path traversal protected)
app.get(/^\/api\/files\/(.+)/, requireAdmin, (req, res) => {
  const requested = path.normalize(req.params[0]).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.resolve(path.join(UPLOADS_DIR, requested));

  if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (fs.existsSync(filePath)) {
    // Stored uploads are immutable for a given serverFileName — a replaced file
    // gets a new name — so the preview pane can reuse them instead of
    // re-downloading on every open.
    res.sendFile(filePath, { maxAge: "1h", etag: true });
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

// Public logo access (no auth — shown on public upload page)
app.get("/api/logo", (req, res) => {
  const filename = getInternalState('_logo_filename');
  if (!filename) return res.status(404).json({ error: "No logo" });
  const filePath = path.resolve(path.join(UPLOADS_DIR, filename));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Logo not found" });
  }
  res.sendFile(filePath);
});

// Get settings
// Push the latest settings/paper types/discount rules to the cloud (fire-and-forget)
function triggerCloudSettingsSync() {
  import('./services/cloudSync.js').then(({ syncSettings, isEnabled }) => {
    if (isEnabled()) syncSettings().catch(() => {});
  }).catch(() => {});
}

// Public settings — allowlisted keys only, no auth (used by the upload page)
app.get("/api/settings", (req, res) => {
  const settings = pickPublicSettings(getSettings());
  settings.paperTypes = getPaperTypes();
  res.status(200).json(settings);
});

// Full settings for the admin UI — secrets stripped, admin token required
app.get("/api/settings/admin", requireAdmin, (req, res) => {
  const settings = stripSecretSettings(getSettings());
  settings.paperTypes = getPaperTypes();
  res.status(200).json(settings);
});

// Probe the cloud with the given (or saved) URL + token so the operator can
// verify credentials BEFORE saving them. The pasted link is parsed the same
// way a save would parse it, so a storefront link tests exactly as it stores.
app.post("/api/cloud/test", requireAdmin, async (req, res) => {
  try {
    const overrides = {};
    if (req.body?.cloudSyncUrl !== undefined) {
      overrides.url = parseCloudLink(req.body.cloudSyncUrl).baseUrl;
    }
    if (req.body?.shopApiToken !== undefined) {
      overrides.token = req.body.shopApiToken;
    }
    const { testConnection } = await import('./services/cloudSync.js');
    res.status(200).json(await testConnection(overrides));
  } catch (err) {
    console.error("❌ Cloud connection test failed:", err);
    res.status(500).json({ ok: false, stage: 'server', message: err.message });
  }
});

// Run one cloud poll on demand ("Check for orders" in the Job Review panel).
// The interval poller keeps running; this just pulls the same cycle forward so
// the operator does not have to wait out the poll interval.
app.post("/api/cloud/poll", requireAdmin, async (req, res) => {
  try {
    const { pollNow, isEnabled } = await import('./services/cloudSync.js');
    if (!isEnabled()) {
      return res.status(400).json({ success: false, error: "Cloud sync is not configured" });
    }
    const imported = await pollNow();
    res.status(200).json({ success: true, imported });
  } catch (err) {
    console.error("❌ Manual cloud poll failed:", err);
    res.status(502).json({ success: false, error: err.message || "Cloud poll failed" });
  }
});

// ── Upload blocklist ─────────────────────────────────────────────────────
// Thin proxies onto the cloud's shop-token blocklist API. The list lives on
// the cloud because that is where uploads are refused; the desktop app is only
// the operator's window onto it, so nothing is cached locally.

app.get("/api/cloud/blocks", requireAdmin, async (req, res) => {
  try {
    const { listBlockedUploaders } = await import('./services/cloudSync.js');
    res.status(200).json(await listBlockedUploaders());
  } catch (err) {
    console.error("\u274c Failed to list blocked uploaders:", err);
    res.status(502).json({ success: false, error: err.message || "Failed to list blocked uploaders" });
  }
});

app.post("/api/cloud/blocks", requireAdmin, async (req, res) => {
  const { kind, value, reason, label } = req.body || {};
  if (!kind || !String(value || '').trim()) {
    return res.status(400).json({ success: false, error: "kind and value are required" });
  }
  try {
    const { blockUploader } = await import('./services/cloudSync.js');
    res.status(200).json(await blockUploader({ kind, value, reason, label }));
  } catch (err) {
    console.error("\u274c Failed to block uploader:", err);
    res.status(502).json({ success: false, error: err.message || "Failed to block uploader" });
  }
});

app.delete("/api/cloud/blocks/:id", requireAdmin, async (req, res) => {
  try {
    const { unblockUploader } = await import('./services/cloudSync.js');
    await unblockUploader(req.params.id);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("\u274c Failed to unblock uploader:", err);
    res.status(502).json({ success: false, error: err.message || "Failed to unblock uploader" });
  }
});

// Update settings (shop info only; paper types use dedicated endpoints)
app.post("/api/settings", requireAdmin, (req, res) => {
  try {
    if (req.body.shopName !== undefined) {
      updateSetting('shopName', req.body.shopName);
    }
    if (req.body.paperTypes && Array.isArray(req.body.paperTypes)) {
      replaceAllPaperTypes(req.body.paperTypes);
    }
    if (req.body.pricing && typeof req.body.pricing === "object") {
      const currentSettings = getSettings();
      const newPricing = {
        colorPerPage:
          parseFloat(req.body.pricing.colorPerPage) ||
          currentSettings.pricing?.colorPerPage ||
          30.0,
        blackWhitePerPage:
          parseFloat(req.body.pricing.blackWhitePerPage) ||
          currentSettings.pricing?.blackWhitePerPage ||
          15.0,
        glossyPerPage:
          parseFloat(req.body.pricing.glossyPerPage) ||
          currentSettings.pricing?.glossyPerPage ||
          50.0,
        cardboardPerPage:
          parseFloat(req.body.pricing.cardboardPerPage) ||
          currentSettings.pricing?.cardboardPerPage ||
          40.0,
      };
      updateSetting('pricing', newPricing);
    }
    if (req.body.discounts !== undefined) {
      updateSetting('discounts', req.body.discounts);
    }
    if (req.body.phoneNumbers !== undefined) {
      updateSetting('phoneNumbers', req.body.phoneNumbers);
    }
    if (req.body.email !== undefined) {
      updateSetting('email', req.body.email);
    }
    if (req.body.address !== undefined) {
      updateSetting('address', req.body.address);
    }
    if (req.body.workingHours !== undefined) {
      updateSetting('workingHours', req.body.workingHours);
    }
    if (req.body.returnPolicy !== undefined) {
      updateSetting('returnPolicy', req.body.returnPolicy);
    }
    if (req.body.currency !== undefined) {
      updateSetting('currency', String(req.body.currency || ''));
    }
    // One pasted store link carries both values: the API base and the slug.
    let slugFromUrl = '';
    if (req.body.cloudSyncUrl !== undefined) {
      const parsed = parseCloudLink(req.body.cloudSyncUrl);
      updateSetting('cloudSyncUrl', parsed.baseUrl);
      slugFromUrl = parsed.slug;
      if (slugFromUrl) updateSetting('cloudShopSlug', slugFromUrl);
    }
    // Normally derived from the link above or cached by the cloud settings
    // sync; still settable by hand. A slug embedded in the pasted link wins.
    if (!slugFromUrl && req.body.cloudShopSlug !== undefined) {
      updateSetting('cloudShopSlug', parseCloudLink(req.body.cloudShopSlug).slug
        || String(req.body.cloudShopSlug || '').trim().replace(/^\/+|\/+$/g, ''));
    }
    if (req.body.shopApiToken !== undefined) {
      updateSetting('shopApiToken', req.body.shopApiToken);
    }
    if (req.body.cloudSyncPollInterval !== undefined) {
      updateSetting('cloudSyncPollInterval', req.body.cloudSyncPollInterval);
    }
    if (req.body.autoAcceptCloudJobs !== undefined) {
      updateSetting('autoAcceptCloudJobs', !!req.body.autoAcceptCloudJobs);
    }
    if (req.body.autoDeductStock !== undefined) {
      updateSetting('autoDeductStock', !!req.body.autoDeductStock);
    }
    // Printer settings — see electron/main.js for the print IPC that
    // consumes these. defaultPrinterName is a plain string (Chromium's
    // deviceName). printerDefaults is a { [printerName]: { duplexMode,
    // color, copies, collate, landscape } } map used as the starting
    // point for both Quick Print and the Options dialog.
    if (req.body.defaultPrinterName !== undefined) {
      updateSetting('defaultPrinterName', String(req.body.defaultPrinterName || ''));
    }
    if (req.body.printerDefaults !== undefined && typeof req.body.printerDefaults === 'object') {
      const clean = {};
      for (const [name, raw] of Object.entries(req.body.printerDefaults || {})) {
        if (!name || typeof raw !== 'object' || raw === null) continue;
        const duplex = ['simplex', 'shortEdge', 'longEdge'].includes(raw.duplexMode)
          ? raw.duplexMode
          : 'simplex';
        const copiesNum = Number(raw.copies);
        clean[name] = {
          duplexMode: duplex,
          color: raw.color !== false,
          copies: Number.isFinite(copiesNum) && copiesNum >= 1 ? Math.floor(copiesNum) : 1,
          collate: raw.collate !== false,
          landscape: raw.landscape === true,
        };
      }
      updateSetting('printerDefaults', clean);
    }

    const settings = stripSecretSettings(getSettings());
    settings.paperTypes = getPaperTypes();
    res.status(200).json({ success: true, settings });

    // Restart cloud sync if config changed
    import('./services/cloudSync.js').then(({ stopCloudSync, startCloudSync }) => {
      stopCloudSync();
      startCloudSync().catch(() => {});
    }).catch(() => {});
  } catch (err) {
    console.error("❌ Settings update error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to update settings" });
  }
});

// Upload logo
app.post("/api/settings/logo", requireAdmin, upload.single("logo"), (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }

    const settings = getSettings();
    const oldFilename = getInternalState('_logo_filename');
    if (oldFilename) {
      const oldPath = path.join(UPLOADS_DIR, oldFilename);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) { console.warn("⚠️  Could not delete old logo"); }
      }
    }

    setInternalState('_logo_filename', req.file.filename);
    const logoUrl = `/api/logo`;
    updateSetting('logoUrl', logoUrl);
    res.status(200).json({ success: true, logoUrl });
  } catch (err) {
    console.error("❌ Logo upload error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Password hashing helpers
const SALT_LEN = 16;
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN);
  return salt.toString("hex") + ":" + key.toString("hex");
}

function verifyHash(password, stored) {
  if (!stored || !stored.includes(":")) {
    return false;
  }
  const [saltHex, keyHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  const derivedKey = scryptSync(password, salt, KEY_LEN);
  if (key.length !== derivedKey.length) return false;
  return timingSafeEqual(key, derivedKey);
}

const DEFAULT_PASSWORD = "admin123";

function passwordPolicyError(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (/^\d+$/.test(pw)) return "Password cannot be all digits";
  if (pw === DEFAULT_PASSWORD) return "Choose a password other than the default";
  return null;
}

// Does `password` match the stored credential? Handles the legacy plaintext
// default and upgrades it to a hash on first successful login.
function checkAdminPassword(password) {
  const stored = getInternalState('adminPassword');
  if (!stored) {
    // Fresh install — the implicit credential is the default password.
    return password === DEFAULT_PASSWORD;
  }
  if (!stored.includes(":")) {
    return password === stored;
  }
  return verifyHash(password, stored);
}

// Is the current credential still the factory default?
function isDefaultPassword() {
  const stored = getInternalState('adminPassword');
  if (!stored) return true;
  if (!stored.includes(":")) return stored === DEFAULT_PASSWORD;
  return verifyHash(DEFAULT_PASSWORD, stored);
}

mustChangePassword = isDefaultPassword();
if (mustChangePassword) {
  console.warn("⚠️  Admin password is the default — operator must change it on next login.");
}

// Verify admin password — returns a session token on success
app.post("/api/auth/verify", loginGuard, (req, res) => {
  const { password } = req.body;
  const ok = checkAdminPassword(password);

  if (!ok) {
    recordLoginFailure(req);
    return res.status(200).json({ success: false });
  }

  clearLoginFailures(req);
  mustChangePassword = isDefaultPassword();
  const token = generateToken();
  res.status(200).json({ success: true, token, mustChangePassword });
});

// Logout — invalidate the caller's token
app.post("/api/auth/logout", (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    adminTokens.delete(auth.slice(7));
    saveTokens(adminTokens);
  }
  res.status(200).json({ success: true });
});

// Logout everywhere else — kill every token except the caller's
app.post("/api/auth/logout-all", requireAdmin, (req, res) => {
  for (const token of [...adminTokens.keys()]) {
    if (token !== req.adminToken) adminTokens.delete(token);
  }
  saveTokens(adminTokens);
  res.status(200).json({ success: true });
});

// Change admin password
app.post("/api/settings/password", requireAdmin, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!checkAdminPassword(currentPassword)) {
      return res.status(401).json({ success: false, error: "Current password is incorrect" });
    }
    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      return res.status(400).json({ success: false, error: policyError });
    }
    setInternalState("adminPassword", hashPassword(newPassword));
    mustChangePassword = false;

    // Invalidate every other session — a password change should log out
    // anything that might have been using the old one.
    for (const token of [...adminTokens.keys()]) {
      if (token !== req.adminToken) adminTokens.delete(token);
    }
    saveTokens(adminTokens);

    console.log("🔑 Admin password updated (hashed); other sessions invalidated");
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Password change error:", err);
    res.status(500).json({ success: false, error: "Failed to change password" });
  }
});

// Get local IP address
app.get("/api/local-ip", (req, res) => {
  try {
    const interfaces = os.networkInterfaces();
    let ips = [];

    // Collect all non-internal IPv4 addresses with interface names
    for (const name of Object.keys(interfaces)) {
      const networkInterface = interfaces[name];
      if (networkInterface) {
        for (const interfaceInfo of networkInterface) {
          if (interfaceInfo.family === "IPv4" && !interfaceInfo.internal) {
            ips.push({
              address: interfaceInfo.address,
              interface: name,
              isWifi:
                name.toLowerCase().includes("wi-fi") ||
                name.toLowerCase().includes("wlan"),
              isEthernet:
                name.toLowerCase().includes("ethernet") ||
                name.toLowerCase().includes("eth"),
            });
          }
        }
      }
    }

    let selectedIP = null;

    // Priority 1: Prefer IPs with common gateway patterns (.1.90, .1.100, .0.1, .1.1)
    const commonPatterns = [".1.90", ".1.100", ".0.1", ".1.1"];
    for (const pattern of commonPatterns) {
      const patternIP = ips.find((ip) => ip.address.endsWith(pattern));
      if (patternIP) {
        selectedIP = patternIP.address;
        break;
      }
    }

    // Priority 2: Look for WiFi interfaces (most common for mobile access)
    if (!selectedIP) {
      const wifiIP = ips.find(
        (ip) => ip.isWifi && ip.address.startsWith("192.168."),
      );
      if (wifiIP) {
        selectedIP = wifiIP.address;
      }
    }

    // Priority 3: Look for Ethernet interfaces
    if (!selectedIP) {
      const ethernetIP = ips.find(
        (ip) => ip.isEthernet && ip.address.startsWith("192.168."),
      );
      if (ethernetIP) {
        selectedIP = ethernetIP.address;
      }
    }

    // Priority 4: Any 192.168.x.x address
    if (!selectedIP) {
      const lanIP = ips.find((ip) => ip.address.startsWith("192.168."));
      if (lanIP) {
        selectedIP = lanIP.address;
      }
    }

    // Priority 5: Any non-internal IP
    if (!selectedIP && ips.length > 0) {
      selectedIP = ips[0].address;
    }

    // Fallback to localhost
    if (!selectedIP) {
      selectedIP = "localhost";
    }

    console.log("🌐 Local IP detected");
    res.status(200).json({ ip: selectedIP });
  } catch (err) {
    console.error("❌ Error getting local IP:", err);
    res.status(500).json({ error: "Failed to get local IP" });
  }
});

/**
 * DISCOUNT RULES API
 */

// Get all discount rules
app.get("/api/discount-rules", (req, res) => {
  try {
    const rules = getDiscountRules();
    res.status(200).json(rules);
  } catch (err) {
    console.error("❌ Error fetching discount rules:", err);
    res.status(500).json({ error: "Failed to fetch discount rules" });
  }
});

// Get active discount rules only
app.get("/api/discount-rules/active", (req, res) => {
  try {
    const rules = getActiveDiscountRules();
    res.status(200).json(rules);
  } catch (err) {
    console.error("❌ Error fetching active discount rules:", err);
    res.status(500).json({ error: "Failed to fetch discount rules" });
  }
});

// Create new discount rule
app.post("/api/discount-rules", requireAdmin, (req, res) => {
  try {
    const { id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap, priority, is_active } = req.body;

    if (!id || !name || !discount_type || !condition_type || threshold === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const rule = createDiscountRule({
      id,
      name,
      discount_type,
      discount_value: parseFloat(discount_value) || 0,
      condition_type,
      threshold: parseInt(threshold) || 0,
      max_discount_cap: max_discount_cap ? parseFloat(max_discount_cap) : null,
      priority: parseInt(priority) || 0,
      is_active: is_active !== undefined ? is_active : true,
    });

    res.status(201).json(rule);
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error creating discount rule:", err);
    res.status(500).json({ error: "Failed to create discount rule" });
  }
});

// Update discount rule
app.put("/api/discount-rules/:id", requireAdmin, (req, res) => {
  try {
    const ruleId = req.params.id;
    const updates = req.body;

    // Convert numeric fields
    if (updates.discount_value !== undefined) {
      updates.discount_value = parseFloat(updates.discount_value);
    }
    if (updates.threshold !== undefined) {
      updates.threshold = parseInt(updates.threshold);
    }
    if (updates.max_discount_cap !== undefined) {
      updates.max_discount_cap = updates.max_discount_cap ? parseFloat(updates.max_discount_cap) : null;
    }
    if (updates.priority !== undefined) {
      updates.priority = parseInt(updates.priority);
    }

    const rule = updateDiscountRule(ruleId, updates);
    if (!rule) {
      return res.status(404).json({ error: "Discount rule not found" });
    }

    res.status(200).json(rule);
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error updating discount rule:", err);
    res.status(500).json({ error: "Failed to update discount rule" });
  }
});

// Delete discount rule
app.delete("/api/discount-rules/:id", requireAdmin, (req, res) => {
  try {
    const ruleId = req.params.id;
    deleteDiscountRule(ruleId);
    res.status(200).json({ success: true, id: ruleId });
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error deleting discount rule:", err);
    res.status(500).json({ error: "Failed to delete discount rule" });
  }
});

/**
 * PAPER TYPES API
 */

// Get all paper types
app.get("/api/paper-types", (req, res) => {
  try {
    res.status(200).json(getPaperTypes());
  } catch (err) {
    console.error("❌ Error fetching paper types:", err);
    res.status(500).json({ error: "Failed to fetch paper types" });
  }
});

// Create paper type
app.post("/api/paper-types", requireAdmin, (req, res) => {
  try {
    const { id, name, nameAr, colorPerPage, blackWhitePerPage } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing required fields (id, name)" });
    }
    const pt = createPaperType({ id, name, nameAr: nameAr || '', colorPerPage: parseFloat(colorPerPage) || 0, blackWhitePerPage: parseFloat(blackWhitePerPage) || 0 });
    res.status(201).json(pt);
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error creating paper type:", err);
    res.status(500).json({ error: "Failed to create paper type" });
  }
});

// Update paper type
app.put("/api/paper-types/:id", requireAdmin, (req, res) => {
  try {
    const pt = updatePaperType(req.params.id, req.body);
    if (!pt) return res.status(404).json({ error: "Paper type not found" });
    res.status(200).json(pt);
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error updating paper type:", err);
    res.status(500).json({ error: "Failed to update paper type" });
  }
});

// Delete paper type
app.delete("/api/paper-types/:id", requireAdmin, (req, res) => {
  try {
    deletePaperType(req.params.id);
    res.status(200).json({ success: true });
    triggerCloudSettingsSync();
  } catch (err) {
    console.error("❌ Error deleting paper type:", err);
    res.status(500).json({ error: "Failed to delete paper type" });
  }
});

/**
 * INVENTORY API
 */

// Get all inventory items (plus the low-stock count the sidebar badge reads)
app.get("/api/inventory", requireAdmin, (req, res) => {
  try {
    res.status(200).json({ items: getInventoryItems(), lowStockCount: getLowStockCount() });
  } catch (err) {
    console.error("❌ Error fetching inventory:", err);
    res.status(500).json({ error: "Failed to fetch inventory" });
  }
});

// Get the adjustment log — all items, or one item when ?itemId= is supplied
app.get("/api/inventory/adjustments", requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.status(200).json(getInventoryAdjustments(req.query.itemId || null, limit));
  } catch (err) {
    console.error("❌ Error fetching inventory adjustments:", err);
    res.status(500).json({ error: "Failed to fetch adjustments" });
  }
});

// Create inventory item
app.post("/api/inventory", requireAdmin, (req, res) => {
  try {
    const { name, category, unit, currentStock, lowStockThreshold, paperTypeId } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Missing required field (name)" });
    }
    if (!INVENTORY_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${INVENTORY_CATEGORIES.join(', ')}` });
    }

    const item = createInventoryItem({
      id: `inv_${randomBytes(8).toString("hex")}`,
      name: String(name).trim(),
      category,
      unit: unit ? String(unit).trim() : 'units',
      currentStock: Math.max(0, parseFloat(currentStock) || 0),
      lowStockThreshold: Math.max(0, parseFloat(lowStockThreshold) || 0),
      paperTypeId: paperTypeId || null,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("❌ Error creating inventory item:", err);
    res.status(500).json({ error: "Failed to create inventory item" });
  }
});

// Update inventory item
app.put("/api/inventory/:id", requireAdmin, (req, res) => {
  try {
    const { name, category, unit, currentStock, lowStockThreshold, paperTypeId } = req.body;
    if (category !== undefined && !INVENTORY_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${INVENTORY_CATEGORIES.join(', ')}` });
    }

    const updates = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (category !== undefined) updates.category = category;
    if (unit !== undefined) updates.unit = String(unit).trim() || 'units';
    if (currentStock !== undefined) updates.currentStock = Math.max(0, parseFloat(currentStock) || 0);
    if (lowStockThreshold !== undefined) updates.lowStockThreshold = Math.max(0, parseFloat(lowStockThreshold) || 0);
    if (paperTypeId !== undefined) updates.paperTypeId = paperTypeId || null;

    const item = updateInventoryItem(req.params.id, updates);
    if (!item) return res.status(404).json({ error: "Inventory item not found" });
    res.status(200).json(item);
  } catch (err) {
    console.error("❌ Error updating inventory item:", err);
    res.status(500).json({ error: "Failed to update inventory item" });
  }
});

// Delete inventory item
app.delete("/api/inventory/:id", requireAdmin, (req, res) => {
  try {
    if (!getInventoryItem(req.params.id)) {
      return res.status(404).json({ error: "Inventory item not found" });
    }
    deleteInventoryItem(req.params.id);
    res.status(200).json({ success: true, id: req.params.id });
  } catch (err) {
    console.error("❌ Error deleting inventory item:", err);
    res.status(500).json({ error: "Failed to delete inventory item" });
  }
});

// Adjust stock. Manual edits and restocks both land here; 'auto_deduct' is
// reserved for the printed-job hook below and is rejected from the API.
app.post("/api/inventory/:id/adjust", requireAdmin, (req, res) => {
  try {
    const { amount, reason, note } = req.body;
    const parsedAmount = parseFloat(amount);
    if (!isFinite(parsedAmount) || parsedAmount === 0) {
      return res.status(400).json({ error: "amount must be a non-zero number" });
    }
    if (reason !== 'manual' && reason !== 'restock') {
      return res.status(400).json({ error: "reason must be 'manual' or 'restock'" });
    }

    const result = adjustInventoryStock(req.params.id, {
      amount: parsedAmount,
      reason,
      note: note ? String(note).trim() : '',
    });
    if (!result) return res.status(404).json({ error: "Inventory item not found" });
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Error adjusting inventory:", err);
    res.status(500).json({ error: "Failed to adjust inventory" });
  }
});

/**
 * Deduct paper stock when a job reaches the printed state.
 *
 * Only fires on an actual transition into PRINTED (re-marking an already-printed
 * job must not deduct twice) and only when the shop has opted in via
 * autoDeductStock. If no inventory item is linked to the job's paper type this
 * does nothing — that's a normal state, not an error.
 *
 * Inventory problems must never fail the status update the customer is waiting
 * on, so everything here is best-effort and logged.
 */
function applyAutoDeductForJob(job, previousStatus) {
  try {
    if (!job || job.status !== 'PRINTED' || previousStatus === 'PRINTED') return;
    if (getSettings().autoDeductStock !== true) return;

    const items = getInventoryItemsByPaperType(job.paperType);
    if (items.length === 0) return;

    const sheets = (job.pageCount || 1) * (job.copies || 1);
    if (sheets <= 0) return;

    for (const item of items) {
      // Idempotency: never auto-deduct the same job/item twice (status toggles).
      if (hasAutoDeductForJob(job.id, item.id)) continue;
      adjustInventoryStock(item.id, {
        amount: -sheets,
        reason: 'auto_deduct',
        note: job.fileName || '',
        jobId: job.id,
      });
      console.log(`📉 Auto-deducted ${sheets} ${item.unit} from "${item.name}" for job ${job.id}`);
    }
  } catch (err) {
    console.error("❌ Auto-deduct error:", err.message);
  }
}

/**
 * GMAIL / EMAIL-TO-PRINT ROUTES
 */
import {
  getAuthUrl,
  handleCallback,
} from './services/gmailService.js';
import { pollGmail, importPendingEmails, discardPendingEmail, startPolling, stopPolling, setNewEmailCallback } from './services/gmailPolling.js';
import { getGmailAccount, disconnectGmail, getPendingEmails, restorePendingEmail } from './db.js';

// Get Gmail connection status
app.get('/api/gmail/status', requireAdmin, (req, res) => {
  try {
    const account = getGmailAccount();
    res.json({
      connected: account?.is_active === 1,
      email: account?.gmail_email || '',
    });
  } catch (err) {
    console.error("❌ Error getting Gmail status:", err);
    res.status(500).json({ error: "Failed to get Gmail status" });
  }
});

// Start OAuth flow
app.get('/api/gmail/auth', requireAdmin, (req, res) => {
  try {
    const redirectUri = process.env.GMAIL_REDIRECT_URI;
    if (!redirectUri) {
      return res.status(500).json({ error: 'GMAIL_REDIRECT_URI environment variable not set' });
    }
    const url = getAuthUrl(redirectUri);
    res.json({ url });
  } catch (err) {
    console.error("❌ Error getting auth URL:", err);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// OAuth callback
app.get('/api/gmail/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('Authorization code required');window.close();<\/script></body></html>`);
    }
    const redirectUri = process.env.GMAIL_REDIRECT_URI;
    if (!redirectUri) {
      return res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('GMAIL_REDIRECT_URI not set');window.close();<\/script></body></html>`);
    }
    const email = await handleCallback(code, redirectUri);

    startPolling(30_000);

    const safeEmail = escapeHtml(email);
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Gmail connected — PrintShop Hub</title><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(1200px 800px at 20% 0%,#eef2ff 0%,transparent 60%),radial-gradient(1000px 700px at 100% 100%,#ecfdf5 0%,transparent 55%),#f8fafc;color:#0f172a}
.card{width:100%;max-width:440px;background:#fff;padding:36px 32px 28px;border-radius:20px;border:1px solid #e2e8f0;box-shadow:0 20px 50px -20px rgba(15,23,42,.18);text-align:center}
.icon{width:64px;height:64px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;border:6px solid #f0fdf4}
.icon svg{width:32px;height:32px;stroke:#16a34a;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin-bottom:6px}
.email{display:inline-block;margin-top:2px;padding:4px 10px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:13px;font-weight:500}
.sub{margin-top:14px;font-size:14px;line-height:1.55;color:#64748b}
.actions{margin-top:22px;display:flex;flex-direction:column;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid transparent;transition:transform .06s ease,background .12s ease}
.btn:active{transform:translateY(1px)}
.btn-primary{background:#4f46e5;color:#fff}
.btn-primary:hover{background:#4338ca}
.btn-ghost{background:transparent;color:#475569;border-color:#e2e8f0}
.btn-ghost:hover{background:#f8fafc}
.hint{margin-top:16px;font-size:12px;color:#94a3b8}
.tab-note{margin-top:8px;font-size:11px;color:#cbd5e1}
</style></head><body>
<div class="card">
  <div class="icon"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
  <h1>Gmail connected</h1>
  <span class="email">${safeEmail}</span>
  <p class="sub">PrintShop Hub will now pull print jobs from this inbox automatically. You can head back to the app.</p>
  <div class="actions">
    <a class="btn btn-primary" href="printshop-hub://return" id="returnBtn">Return to PrintShop Hub</a>
    <button class="btn btn-ghost" id="closeBtn" type="button">Close this tab</button>
  </div>
  <p class="hint">This tab will close automatically in a few seconds.</p>
  <p class="tab-note">If the button above doesn't open the app, switch to it manually from the taskbar.</p>
</div>
<script>
  document.getElementById('closeBtn').addEventListener('click', function(){ window.close(); });
  // Auto-close after 4s. Modern browsers only allow window.close() on windows
  // opened by script — the OAuth flow qualifies (Google popped this tab from
  // window.open on accounts.google.com), so this usually works.
  setTimeout(function(){ try { window.close(); } catch(e) {} }, 4000);
<\/script>
</body></html>`);
  } catch (err) {
    console.error("❌ Error in Gmail callback:", err);
    const safeMsg = escapeHtml(err.message);
    res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('${safeMsg.replace(/'/g, "\\'")}');window.close();<\/script></body></html>`);
  }
});

// Disconnect Gmail
app.post('/api/gmail/disconnect', requireAdmin, (req, res) => {
  try {
    stopPolling();
    disconnectGmail();
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error disconnecting Gmail:", err);
    res.status(500).json({ error: "Failed to disconnect Gmail" });
  }
});

// Manual poll trigger
app.post('/api/gmail/poll', requireAdmin, async (req, res) => {
  try {
    const result = await pollGmail();
    res.json(result);
  } catch (err) {
    console.error("❌ Error polling Gmail:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cloud-sync failure signal ──
// Status pushes to the cloud are fire-and-forget, but silently swallowing the
// rejection meant a shop with an expired token had no way to know its customers
// were seeing stale statuses. Warn once per minute (not per job) so a bulk
// update of 200 rows does not flood the log.
let lastCloudSyncWarnAt = 0;
function warnCloudSyncFailed(count, err) {
  const now = Date.now();
  if (now - lastCloudSyncWarnAt < 60_000) return;
  lastCloudSyncWarnAt = now;
  console.warn(
    `⚠️  Cloud status sync failed for ${count} job(s): ${err?.message || err}. ` +
    `Check the shop token in Settings → Cloud.`
  );
  broadcastEvent('cloud-sync-error', { message: err?.message || String(err) });
}

// ── General SSE event bus ──
// Admin-only. EventSource cannot set an Authorization header, so this one
// endpoint also accepts the admin token as a `?token=` query parameter; every
// other endpoint stays header-only.
const SSE_MAX_CLIENTS = 50;
const SSE_MAX_PER_IP = 5;
const SSE_KEEPALIVE_MS = 25_000;
const sseClients = new Set();
const sseIpCounts = new Map(); // ip -> open connection count

function broadcastEvent(event, data) {
  for (const client of sseClients) {
    try {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

app.get('/api/events', (req, res) => {
  // Header first (normal fetch clients), then the query fallback EventSource
  // needs. Both go through the same token map + prune.
  let token = validAdminToken(req);
  if (!token && typeof req.query.token === 'string') {
    pruneTokens();
    const meta = adminTokens.get(req.query.token);
    if (meta) {
      meta.lastUsedAt = Date.now();
      token = req.query.token;
    }
  }
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (sseClients.size >= SSE_MAX_CLIENTS) {
    return res.status(503).end();
  }
  const ip = clientIp(req);
  if ((sseIpCounts.get(ip) || 0) >= SSE_MAX_PER_IP) {
    return res.status(503).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {}\n\n');

  sseClients.add(res);
  sseIpCounts.set(ip, (sseIpCounts.get(ip) || 0) + 1);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    sseClients.delete(res);
    const left = (sseIpCounts.get(ip) || 1) - 1;
    if (left > 0) sseIpCounts.set(ip, left);
    else sseIpCounts.delete(ip);
  }

  // Comment-only keepalive: stops proxies and idle-socket timeouts from
  // silently dropping a stream that has had no events for minutes.
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, SSE_KEEPALIVE_MS);

  req.on('close', cleanup);
  res.on('close', cleanup);
});

// Poll health status
app.get('/api/gmail/poll-status', requireAdmin, (req, res) => {
  try {
    res.json(getPollStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List pending emails (awaiting user review)
app.get('/api/gmail/pending', requireAdmin, (req, res) => {
  try {
    const pending = getPendingEmails().map(p => ({
      ...p,
      attachment_meta: JSON.parse(p.attachment_meta || '[]'),
    }));
    res.json(pending);
  } catch (err) {
    console.error("❌ Error listing pending emails:", err);
    res.status(500).json({ error: err.message });
  }
});

// Import selected pending emails → create print jobs
app.post('/api/gmail/import', requireAdmin, async (req, res) => {
  try {
    const { ids, overrides } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    const result = await importPendingEmails(ids, overrides || {});
    res.json(result);
  } catch (err) {
    console.error("❌ Error importing emails:", err);
    res.status(500).json({ error: err.message });
  }
});

// Discard a pending email (soft-delete)
app.delete('/api/gmail/pending/:id', requireAdmin, (req, res) => {
  try {
    discardPendingEmail(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error discarding pending email:", err);
    res.status(500).json({ error: err.message });
  }
});

// Restore a discarded pending email
app.post('/api/gmail/pending/:id/restore', requireAdmin, (req, res) => {
  try {
    restorePendingEmail(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error restoring pending email:", err);
    res.status(500).json({ error: err.message });
  }
});

// In-memory rate limiter for attachment previews (30 req/min per IP)
const previewRateMap = new Map();
setInterval(() => previewRateMap.clear(), 60 * 1000);

function checkPreviewRateLimit(ip) {
  const count = previewRateMap.get(ip) || 0;
  if (count >= 30) return false;
  previewRateMap.set(ip, count + 1);
  return true;
}

const PREVIEW_CACHE_DIR = path.join(UPLOADS_DIR, 'preview_cache');

// Get attachment data for preview (with caching)
app.get('/api/gmail/attachment/:pendingId/:attachmentIndex', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkPreviewRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests — try again in a minute' });
    }

    const pendingId = parseInt(req.params.pendingId);
    const attachmentIndex = parseInt(req.params.attachmentIndex);
    const { getPendingEmailById } = await import('./db.js');
    const pending = getPendingEmailById(pendingId);
    if (!pending) return res.status(404).json({ error: 'Pending email not found' });

    const atts = pending.attachment_meta || [];
    const att = atts[attachmentIndex];
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    // Check cache first
    const safeFilename = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const cacheKey = `${pendingId}_${attachmentIndex}_${safeFilename}`;
    const cachePath = path.join(PREVIEW_CACHE_DIR, cacheKey);

    if (!fs.existsSync(PREVIEW_CACHE_DIR)) {
      fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
    }

    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath);
      res.set('Content-Type', att.mimeType);
      res.set('Content-Disposition', `inline; filename="${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
      return res.send(cached);
    }

    const { getGmailClient } = await import('./services/gmailService.js');
    const gmail = await getGmailClient();
    const attResponse = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: pending.gmail_message_id,
      id: att.attachmentId,
    });

    const buffer = Buffer.from(attResponse.data.data, 'base64');

    // Save to cache
    fs.writeFileSync(cachePath, buffer);

    res.set('Content-Type', att.mimeType);
    res.set('Content-Disposition', `inline; filename="${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.send(buffer);
  } catch (err) {
    console.error("❌ Error fetching attachment:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get Gmail settings — one template per notification type, each tagged with
// the language its substituted values should render in ("en" or "ar").
app.get('/api/gmail/settings', requireAdmin, (req, res) => {
  try {
    const settings = getSettings();
    res.json({
      pollInterval: parseInt(settings.gmailPollInterval) || 60,
      replyTemplate: settings.gmailReplyTemplate || '',
      replyTemplateLang: settings.gmailReplyTemplateLang || 'en',
      readyTemplate: settings.gmailReadyTemplate || '',
      readyTemplateLang: settings.gmailReadyTemplateLang || 'en',
    });
  } catch (err) {
    console.error("❌ Error getting Gmail settings:", err);
    res.status(500).json({ error: "Failed to get Gmail settings" });
  }
});

app.post('/api/gmail/settings', requireAdmin, async (req, res) => {
  try {
    if (req.body.pollInterval) {
      updateSetting('gmailPollInterval', parseInt(req.body.pollInterval));
      const { restartPolling } = await import('./services/gmailPolling.js');
      restartPolling(parseInt(req.body.pollInterval) * 1000);
    }
    if (req.body.replyTemplate !== undefined) {
      updateSetting('gmailReplyTemplate', req.body.replyTemplate);
    }
    if (req.body.replyTemplateLang !== undefined) {
      const lang = req.body.replyTemplateLang === 'ar' ? 'ar' : 'en';
      updateSetting('gmailReplyTemplateLang', lang);
    }
    if (req.body.readyTemplate !== undefined) {
      updateSetting('gmailReadyTemplate', req.body.readyTemplate);
    }
    if (req.body.readyTemplateLang !== undefined) {
      const lang = req.body.readyTemplateLang === 'ar' ? 'ar' : 'en';
      updateSetting('gmailReadyTemplateLang', lang);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error saving Gmail settings:", err);
    res.status(500).json({ error: "Failed to save Gmail settings" });
  }
});

/**
 * STATIC FILE SERVING & SPA ROUTING
 */

// Serve public/ assets (notification sound, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Serve static files in production
if (!isDev) {
  app.use(
    express.static(DIST_DIR, {
      etag: true,
      setHeaders: (res, filePath) => {
        // Vite content-hashes everything under /assets, so those can be cached
        // forever; index.html must not be, or a new build never reaches the UI.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          res.setHeader("Cache-Control", "public, max-age=86400");
        }
      },
    }),
  );
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("❌ Unhandled Error:", err.stack);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: isDev ? err.message : "Internal Server Error",
    });
  }
});

// SPA fallback (must be last)
if (!isDev) {
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "API endpoint not found" });
    }
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

/**
 * SERVER STARTUP
 */
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log("\n🚀 Server started successfully!");
  console.log(`📦 Environment: ${NODE_ENV}`);
  console.log(`🌐 Server URL: http://${HOST}:${PORT}`);

  if (isDev) {
    console.log(`🔧 Development mode - CORS enabled for http://localhost:3000`);
    console.log(`💡 Frontend should run on port 5173 (Vite default)`);
  } else {
    console.log(`📁 Serving static files from: ${DIST_DIR}`);
  }

  console.log(`📂 Uploads directory: ${UPLOADS_DIR.replace(__dirname, '.')}`);
  console.log(`💾 SQLite database: database.sqlite\n`);

  const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI;
  if (!gmailRedirectUri) {
    console.warn('⚠️  GMAIL_REDIRECT_URI not set — Gmail OAuth flow will not work');
    console.warn('   Set GMAIL_REDIRECT_URI in your .env file, e.g.:');
    console.warn('   GMAIL_REDIRECT_URI=http://localhost:3001/api/gmail/callback');
  }

  // Auto-poll Gmail every 30s — broadcasts new emails to SSE clients
  setNewEmailCallback((count) => {
    broadcastEvent("gmail-new", { new: count });
  });

  const acct = getGmailAccount();
  if (acct?.is_active) {
    console.log('📬 Gmail account connected, starting auto-poll every 30s...');
    startPolling(30_000);
  }

  // Start cloud sync (background) — broadcasts newly-imported orders to SSE clients
  import('./services/cloudSync.js').then(({ startCloudSync, setNewJobCallback }) => {
    setNewJobCallback((job) => {
      broadcastEvent("cloud-job-imported", job);
    });
    startCloudSync().catch(err => {
      console.error('❌ Cloud sync startup error:', err.message);
    });
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n⏹️  SIGTERM received, shutting down gracefully...");
  db.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n⏹️  SIGINT received, shutting down gracefully...");
  db.close();
  process.exit(0);
});
