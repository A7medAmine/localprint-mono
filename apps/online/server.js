import 'dotenv/config';
import express from "express";
import compression from "compression";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { randomBytes, randomUUID, createHash } from "crypto";

const hashDeleteToken = (token) => createHash("sha256").update(String(token)).digest("hex");

import supabase, {
  getSettings,
  updateSetting,
  getPaperTypes,
  replaceAllPaperTypes,
  getDiscountRules,
  getActiveDiscountRules,
  hashToken,
  getShopBySlug,
  getShopByTokenHash,
  createShop,
  listShops,
  listPublicShops,
  getPlatformStats,
  rotateShopToken,
  updateShop,
  getSupabaseUserFromToken,
  AuthUnavailableError,
  getProfile,
  getProfileCamel,
  upsertProfile,
  getCustomerOrders,
  BLOCK_KINDS,
  hashFingerprint,
  normalizeBlockValue,
  listBlockedUploaders,
  addBlockedUploader,
  removeBlockedUploader,
  findUploaderBlock,
} from './db.js';
import { toApiOrder, fromApiOrder } from './utils/orderMapping.js';
import { ALLOWED_MIMES, magicBytesMatch } from '@atba3li/shared/validation';
import { makeRateLimiter, securityHeaders } from '@atba3li/shared/http';
import {
  SESSION_COOKIE,
  readAdminCredentials,
  checkCredentials,
  createSession,
  getSession,
  destroySession,
  isLockedOut,
  recordFailure,
  clearFailures,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  safeEqual,
} from './auth/adminAuth.js';
import { countPdfPagesFromBuffer } from '@atba3li/shared/pdf';
import { calculatePrintPrice, calculateJobDiscount } from '@atba3li/shared/pricing';

// ── Magic byte validation ──
// Signature table + matcher live in @atba3li/shared/validation (shared, tested).
// Here we just read the file's head off disk and delegate the comparison.
function validateMagicBytes(filePath, mimeType) {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  return magicBytesMatch(buf, mimeType);
}

// ── Settings exposure control ──
// The per-shop `settings` KV bag also holds internal keys (`_logo_filename`,
// cached tokens, ...). The public price-calculator endpoint gets an allowlist
// only; the shop's own desktop app pulls the full set over its shop token.
const PUBLIC_SETTINGS_KEYS = new Set([
  "shopName", "logoUrl", "pricing", "discounts",
  "phoneNumbers", "email", "address", "workingHours", "returnPolicy",
  "currency",
]);

function pickPublicSettings(settings) {
  const out = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

// ── Shop token middleware — resolves which shop a Bearer token belongs to ──
async function requireShopToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const shop = await getShopByTokenHash(hashToken(auth.slice(7)));
    if (!shop) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (shop.is_active === false) {
      return res.status(403).json({ error: 'Shop is deactivated' });
    }
    req.shop = shop;
    next();
  } catch (err) {
    console.error('❌ Shop token lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Platform super-admin auth ──
// Browser console → username/password login backed by an httpOnly session
// cookie (see auth/adminAuth.js). Scripts/curl → the long-lived
// PLATFORM_ADMIN_TOKEN bearer, kept for the provisioning tooling.
const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || "";
const ADMIN_CREDS = readAdminCredentials();

function bearerIsPlatformToken(req) {
  const auth = req.headers.authorization || "";
  if (!PLATFORM_ADMIN_TOKEN || !auth.startsWith("Bearer ")) return false;
  return safeEqual(auth.slice(7), PLATFORM_ADMIN_TOKEN);
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getSession(cookies[SESSION_COOKIE]);
}

function requirePlatformAdmin(req, res, next) {
  if (bearerIsPlatformToken(req)) {
    req.adminAuth = { via: "token", username: "token" };
    return next();
  }

  const session = sessionFromRequest(req);
  if (session) {
    // Double-submit CSRF: the cookie alone must not be enough to mutate state.
    // SameSite=Strict already blocks cross-site form posts; this covers the
    // rest (same-site subdomain takeover, a stray <img> GET is read-only).
    if (req.method !== "GET" && req.method !== "HEAD") {
      const supplied = req.headers["x-csrf-token"] || "";
      if (!supplied || !safeEqual(supplied, session.csrf)) {
        return res.status(403).json({ error: "Invalid CSRF token" });
      }
    }
    req.adminAuth = { via: "session", username: session.username };
    return next();
  }

  if (!ADMIN_CREDS.configured && !PLATFORM_ADMIN_TOKEN) {
    return res.status(503).json({
      error: "Super-admin login is not configured. Set PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD_HASH (node scripts/admin-password.js).",
    });
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Shop slug middleware — resolves the shop for public customer-facing routes ──
async function resolveShopBySlug(req, res, next) {
  try {
    const shop = await getShopBySlug(req.params.shopSlug);
    if (!shop || shop.is_active === false) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    req.shop = shop;
    next();
  } catch (err) {
    console.error('❌ Shop slug lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Upload blocklist ─────────────────────────────────────────────────────
// A shop operator can block an abusive uploader by IP, device fingerprint,
// phone or signed-in account (see migration 002 / db.js block helpers).

/** The visitor's stable per-browser id, hashed. Absent for non-browser callers. */
const uploaderFingerprint = (req) => hashFingerprint(req.headers['x-device-id']);

/**
 * Refuse a blocked uploader BEFORE multer writes the file to disk.
 *
 * Runs on ip / fingerprint / user only — the phone number lives in the
 * multipart body, which has not been parsed yet, so the upload handler
 * re-checks it once the metadata is available.
 *
 * A blocklist lookup failure must not take uploads down, so an error here is
 * logged and the request proceeds; the blocklist is an abuse control, not an
 * authorization boundary.
 */
async function rejectBlockedUploader(req, res, next) {
  try {
    const block = await findUploaderBlock(req.shop.id, {
      ip: req.ip,
      fingerprint: uploaderFingerprint(req),
      userId: req.userId || null,
    });
    if (block) {
      console.warn(`\u26d4 Blocked upload to shop ${req.shop.id} (${block.kind})`);
      return res.status(403).json({ success: false, error: BLOCKED_MESSAGE });
    }
  } catch (err) {
    console.error('\u274c Blocklist check failed \u2014 allowing upload:', err.message);
  }
  next();
}

// Deliberately vague: telling someone which identifier is blocked tells them
// exactly what to change to get around it.
const BLOCKED_MESSAGE = "This store is not accepting uploads from you. Please contact the store.";

// ── Optional customer auth — attaches req.userId if a valid Supabase JWT is
// present, but never rejects the request. Guest requests (no/invalid token)
// pass through untouched. ──
async function _optionalCustomerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const user = await getSupabaseUserFromToken(auth.slice(7));
      if (user) req.userId = user.id;
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        // The caller *is* signed in — we just can't confirm who they are.
        // Proceeding would silently file their order as a guest upload and
        // orphan it from their account, so fail loudly and let them retry.
        console.error('❌ optionalCustomerAuth unavailable:', err.message);
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'Authentication temporarily unavailable' });
      }
      console.error('❌ optionalCustomerAuth error:', err.message);
    }
  }
  next();
}

// ── Lenient optional auth — for the PUBLIC upload route, where most callers
// are guests. If auth is unavailable we downgrade a token-carrying request to
// guest and tag it req.authDeferred so it can be reconciled to the account
// later, rather than 503-ing a walk-in customer's upload. ──
async function optionalCustomerAuthLenient(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const user = await getSupabaseUserFromToken(auth.slice(7));
      if (user) req.userId = user.id;
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        console.warn('⚠️  auth unavailable on upload — proceeding as guest (deferred):', err.message);
        req.authDeferred = true;
      } else {
        console.error('❌ optionalCustomerAuthLenient error:', err.message);
      }
    }
  }
  next();
}

// ── Strict customer auth — for account-only endpoints. Rejects with 401 if
// there's no valid customer JWT. ──
async function requireCustomerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const user = await getSupabaseUserFromToken(auth.slice(7));
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      // Not the client's fault and the token may well be valid — a 401 here
      // would read as "logged out" and throw away a good session.
      console.error('❌ requireCustomerAuth unavailable:', err.message);
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Authentication temporarily unavailable' });
    }
    console.error('❌ requireCustomerAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Rate limiters (in-memory, per-IP) ──
// Factory shared with the desktop app (@atba3li/shared/http). Each keeps
// its own hit map + GC interval internally.
// The upload endpoint takes ONE file per request, so a customer sending a
// 10-file batch legitimately makes 10 calls back-to-back. The old budget of 5
// per minute rejected the 6th file of a normal order, which is what customers
// hit as "Too many requests" mid-upload. Budget for a realistic batch instead,
// over a window long enough to still cap abuse.
const uploadRateLimit = makeRateLimiter({
  windowMs: 60_000,
  max: 40,
  message: "Too many uploads from this connection. Wait a moment and try again.",
});
// PLATFORM_ADMIN_TOKEN is a single long-lived bearer with no lockout of its
// own — throttle guesses against it.
const adminRateLimit = makeRateLimiter({ windowMs: 60_000, max: 60 });
// Password login gets a much tighter per-IP budget on top of the per-account
// lockout in auth/adminAuth.js.
const adminLoginRateLimit = makeRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: "Too many login attempts. Try again in a few minutes.",
});
// deleteToken / order-id guessing protection on the customer-facing delete route.
const deleteRateLimit = makeRateLimiter({ windowMs: 60_000, max: 20 });

// ── Allowed MIME types for upload ──
// Set lives in @atba3li/shared/validation (shared, tested); imported above.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV === "development";
const PORT = process.env.PORT || (isDev ? 5001 : 3000);
// Vercel runs this as a serverless function, not a long-lived listener.
const isVercel = process.env.VERCEL === "1";

const DIST_DIR = path.join(__dirname, "dist");
// Vercel's serverless filesystem is read-only except /tmp — route uploads to a
// throwaway dir there. Ephemeral: files vanish after the instance is recycled,
// so this is for previews/trials only; the VPS path (DEPLOYMENT.md) is the
// durable one.
const UPLOADS_DIR = isVercel ? path.join(os.tmpdir(), "atba3li-uploads") : path.join(__dirname, "uploads");

const app = express();

// Cloudflare + the box's reverse proxy sit in front — trust one proxy hop so
// req.ip is the real client (the rate limiter keys on it).
app.set("trust proxy", 1);

// Cap body sizes; file uploads go through multer, not these parsers.
// gzip text responses. Excludes SSE — buffering the order-status stream would
// delay the very updates it exists to push.
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type") || "");
      if (type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

if (isDev) {
  const devOrigin = process.env.DEV_CORS_ORIGIN || "http://localhost:5000";
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", devOrigin);
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });
}

// Static security headers + the pdf.js-compatible CSP. connect-src also allows
// Supabase (customer auth + storage). Shared with the desktop app; see
// @atba3li/shared/http for the CSP rationale.
// Cloudflare injects its Web Analytics beacon (static.cloudflareinsights.com)
// into proxied responses; without these two entries the browser console fills
// with CSP violations for a script we did not add. The injected INLINE snippet
// that loads it is still blocked by design — turn off Rocket Loader / Web
// Analytics in the Cloudflare dashboard if you want that noise gone too.
app.use(securityHeaders({
  connectSrc: ["'self'", "blob:", "https://*.supabase.co", "https://static.cloudflareinsights.com"],
  scriptSrc: ["https://static.cloudflareinsights.com"],
  hsts: !isDev,
}));

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DIST_DIR) && !isDev) {
  console.warn("⚠️  DIST_DIR does not exist. Run build first!");
}

/**
 * PDF Page Count Helper
 */
const getPdfPageCount = async (filePath) => {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const pageCount = await countPdfPagesFromBuffer(fileBuffer);
    console.log(`📄 PDF page count for ${path.basename(filePath)}: ${pageCount}`);
    return pageCount;
  } catch (err) {
    console.error(`❌ Error reading PDF page count for ${path.basename(filePath)}:`, err.message);
    return null;
  }
};

// Backfill missing pageCount for existing PDF orders (runs once at startup)
const backfillPageCounts = async () => {
  const { data: pdfOrdersMissingCount, error } = await supabase
    .from('orders')
    .select('*')
    .eq('filetype', 'application/pdf')
    .or('pagecount.is.null,pagecount.eq.0');

  if (error) { console.error("❌ Backfill query error:", error); return; }
  if (!pdfOrdersMissingCount || pdfOrdersMissingCount.length === 0) {
    console.log("✅ All PDF orders already have page counts.");
    return;
  }

  console.log(`📚 Backfilling page counts for ${pdfOrdersMissingCount.length} PDF order(s)...`);

  for (const order of pdfOrdersMissingCount) {
    if (!order.serverfilename) {
      console.warn(`  ⚠️  Order ${order.id} has no serverFileName — skipping.`);
      continue;
    }
    const filePath = path.join(UPLOADS_DIR, order.serverfilename);
    if (fs.existsSync(filePath)) {
      const count = await getPdfPageCount(filePath);
      if (count !== null) {
        await supabase.from('orders').update({ pagecount: count }).eq('id', order.id);
        console.log(`  ✅ ${order.filename}: ${count} page(s)`);
      } else {
        console.warn(`  ⚠️  Could not count pages for ${order.filename}`);
      }
    } else {
      console.warn(`  ⚠️  File not found for order ${order.id}`);
    }
  }
};

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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Allowed: PDF, DOCX, XLSX, JPEG, PNG, TIFF`));
    }
  },
});

/**
 * PUBLIC API ROUTES
 */

// Favicon
app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#2563eb"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">P</text></svg>`);
});

// Health check
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", environment: NODE_ENV, timestamp: new Date().toISOString() });
});

// ── SSE subscribers, keyed by orderId ──
// When /api/shop/status updates an order, we push a live event to any open
// customer streams watching that orderId — no polling.
const statusSubscribers = new Map(); // orderId -> Set<res>

// This endpoint is public (no auth — the order ids are the capability), so it
// needs its own connection budget: an open stream costs a socket plus a
// keepalive timer, and nothing else caps how many a single client may hold.
const STREAM_MAX_PER_IP = 5;
const STREAM_MAX_AGE_MS = 30 * 60_000; // hard close after 30 min; client reconnects
const streamIpCounts = new Map(); // ip -> open stream count
const streamClientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

function subscribeToOrder(orderId, res) {
  if (!statusSubscribers.has(orderId)) statusSubscribers.set(orderId, new Set());
  statusSubscribers.get(orderId).add(res);
}

function unsubscribeFromOrder(orderId, res) {
  const set = statusSubscribers.get(orderId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) statusSubscribers.delete(orderId);
}

function broadcastStatusChange(orderId, status) {
  const set = statusSubscribers.get(orderId);
  if (!set) return;
  const payload = `event: status-change\ndata: ${JSON.stringify({ orderId, status })}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { /* client gone; will be cleaned up on 'close' */ }
  }
}

// Customer-facing SSE stream for live order status updates.
// The client passes ?ids=id1,id2,... — same allowlist idea as /orders/query.
app.get("/api/s/:shopSlug/orders/stream", resolveShopBySlug, async (req, res) => {
  const raw = String(req.query.ids || "").trim();
  const requestedIds = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
  if (requestedIds.length === 0) {
    return res.status(400).json({ error: "ids query parameter is required" });
  }

  // Cap concurrent streams per client before spending a Supabase round-trip.
  const ip = streamClientIp(req);
  if ((streamIpCounts.get(ip) || 0) >= STREAM_MAX_PER_IP) {
    return res.status(503).json({ error: "Too many open status streams" });
  }

  // Only subscribe to ids that actually belong to this shop.
  const { data: rows, error } = await supabase
    .from('orders')
    .select('id')
    .eq('shop_id', req.shop.id)
    .in('id', requestedIds);
  if (error) return res.status(500).json({ error: error.message });
  const validIds = (rows || []).map(r => r.id);
  if (validIds.length === 0) {
    return res.status(404).json({ error: "No matching orders" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Bypass the app-wide X-Frame-Options: DENY so this works if ever embedded.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(`: connected ${validIds.length}\n\n`);

  for (const id of validIds) subscribeToOrder(id, res);
  streamIpCounts.set(ip, (streamIpCounts.get(ip) || 0) + 1);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    clearTimeout(maxAge);
    for (const id of validIds) unsubscribeFromOrder(id, res);
    const left = (streamIpCounts.get(ip) || 1) - 1;
    if (left > 0) streamIpCounts.set(ip, left);
    else streamIpCounts.delete(ip);
  }

  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { cleanup(); }
  }, 25_000);

  // A NAT'd or half-dead client can hold a stream open long after the browser
  // is gone; the keepalive write alone does not always surface that. Close on
  // a hard ceiling and let EventSource reconnect if the page is still there.
  const maxAge = setTimeout(() => {
    cleanup();
    try { res.end(); } catch { /* already gone */ }
  }, STREAM_MAX_AGE_MS);

  req.on("close", cleanup);
  res.on("close", cleanup);
});

// Platform super-admin console (login page + dashboard in one document).
app.get("/platform-admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "platform-admin.html"));
});

// ── Platform-admin API ──
app.use("/api/admin", adminRateLimit);

// Session login. Deliberately outside requirePlatformAdmin.
app.post("/api/admin/login", adminLoginRateLimit, (req, res) => {
  if (!ADMIN_CREDS.configured) {
    return res.status(503).json({
      error: "Super-admin login is not configured. Run: node scripts/admin-password.js \"<password>\" and set the printed variables.",
    });
  }
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  if (isLockedOut(username)) {
    return res.status(429).json({ error: "Too many failed attempts. Locked for 15 minutes." });
  }
  if (!checkCredentials(username, password, ADMIN_CREDS)) {
    recordFailure(username);
    return res.status(401).json({ error: "Invalid username or password" });
  }
  clearFailures(username);
  const { sid, csrf, maxAgeMs } = createSession(ADMIN_CREDS.username);
  res.setHeader("Set-Cookie", sessionCookie(sid, { secure: !isDev, maxAgeMs }));
  res.json({ username: ADMIN_CREDS.username, csrfToken: csrf });
});

app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies[SESSION_COOKIE]);
  res.setHeader("Set-Cookie", clearedSessionCookie({ secure: !isDev }));
  res.json({ ok: true });
});

// Who am I — the console calls this on load to decide login screen vs dashboard.
app.get("/api/admin/me", (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({
      error: "Unauthorized",
      configured: ADMIN_CREDS.configured,
    });
  }
  res.json({ username: session.username, csrfToken: session.csrf });
});

app.post("/api/admin/shops", requirePlatformAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    const shop = await createShop(name);
    // token shown once
    res.status(201).json({ id: shop.id, slug: shop.slug, name: shop.name, token: shop.token });
  } catch (err) {
    console.error("❌ createShop:", err);
    res.status(500).json({ error: "Failed to create shop" });
  }
});

app.get("/api/admin/shops", requirePlatformAdmin, async (req, res) => {
  try {
    res.json(await listShops());
  } catch (err) {
    console.error("❌ listShops:", err);
    res.status(500).json({ error: "Failed to list shops" });
  }
});

app.get("/api/admin/stats", requirePlatformAdmin, async (req, res) => {
  try {
    res.json(await getPlatformStats());
  } catch (err) {
    console.error("❌ getPlatformStats:", err);
    // 42703 = undefined_column: the database is behind the code. Say which fix
    // is needed instead of a blank "failed to load".
    if (err?.code === "42703") {
      return res.status(503).json({
        error: `Database schema is out of date (${err.message}). Run the pending files in apps/online/supabase/migrations in the Supabase SQL editor.`,
      });
    }
    res.status(500).json({ error: "Failed to load stats" });
  }
});

app.post("/api/admin/shops/:id/rotate-token", requirePlatformAdmin, async (req, res) => {
  try {
    const result = await rotateShopToken(req.params.id);
    if (!result) return res.status(404).json({ error: "Shop not found" });
    res.json(result); // { id, slug, name, token } — token shown once
  } catch (err) {
    console.error("❌ rotateShopToken:", err);
    res.status(500).json({ error: "Failed to rotate token" });
  }
});

app.patch("/api/admin/shops/:id", requirePlatformAdmin, async (req, res) => {
  try {
    const { name, slug, isActive } = req.body || {};
    const result = await updateShop(req.params.id, { name, slug, is_active: isActive });
    if (!result) return res.status(400).json({ error: "Nothing to update" });
    res.json(result);
  } catch (err) {
    console.error("❌ updateShop:", err);
    res.status(500).json({ error: "Failed to update shop" });
  }
});

// Public upload endpoint (rate-limited). Lenient auth: a guest, or a signed-in
// customer downgraded to guest if Supabase auth is briefly unavailable.
app.post("/api/s/:shopSlug/upload", uploadRateLimit, resolveShopBySlug, optionalCustomerAuthLenient, rejectBlockedUploader, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const metadata = JSON.parse(req.body.metadata || "{}");
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

    // Second half of the blocklist check: the phone number only exists once
    // multer has parsed the multipart body, so it can't be caught by the
    // pre-upload middleware. Drop the file we just wrote before refusing.
    const blockedPhone = metadata.phoneNumber
      ? await findUploaderBlock(req.shop.id, { phone: metadata.phoneNumber }).catch((err) => {
          console.error('\u274c Blocklist phone check failed \u2014 allowing upload:', err.message);
          return null;
        })
      : null;
    if (blockedPhone) {
      try { fs.unlinkSync(filePath); } catch { /* ignored */ }
      console.warn(`\u26d4 Blocked upload to shop ${req.shop.id} (phone)`);
      return res.status(403).json({ success: false, error: BLOCKED_MESSAGE });
    }

    if (!validateMagicBytes(filePath, req.file.mimetype)) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: "File content does not match its type" });
    }

    let pageCount = null;
    if (req.file.mimetype === "application/pdf") {
      pageCount = await getPdfPageCount(filePath);
    }

    // Logged-in customers can omit name/phone and fall back to their saved profile.
    let profile = null;
    if (req.userId) {
      profile = await getProfile(req.userId);
    }

    // Server-side price authority. Rather than trusting the client's quoted
    // number, recompute the price here with the SAME shared calculator the
    // client uses (@atba3li/shared/pricing) against this shop's real
    // settings, paper types and active discount rules. The client quote is
    // advisory only; the number we persist is ours.
    const priceSettings = await getSettings(req.shop.id);
    priceSettings.paperTypes = await getPaperTypes(req.shop.id);
    const activeRules = await getActiveDiscountRules(req.shop.id);

    // Best page count the server can stand behind: exact for PDFs (counted
    // above), 1 for images, size-estimate otherwise (we can't render a DOCX to
    // count it, so we mirror the shared getActualPageCount fallback).
    const authoritativePages =
      pageCount && pageCount > 0
        ? pageCount
        : req.file.mimetype.includes('image')
        ? 1
        : Math.max(1, Math.ceil(req.file.size / 75000));

    const priceJob = {
      printPreferences: {
        colorMode: metadata.printPreferences?.colorMode || 'color',
        copies: metadata.printPreferences?.copies || 1,
        paperType: metadata.printPreferences?.paperType || 'normal',
      },
    };
    const priceCalc = calculatePrintPrice(priceJob, priceSettings, authoritativePages);
    const discountResult = calculateJobDiscount(priceJob, priceCalc.totalPrice, priceCalc.totalPages, activeRules);
    const serverPrice = discountResult.finalAmount;

    // Surface tampering / stale quotes without failing the upload.
    const clientQuote = typeof metadata.quotedPrice === 'number' && Number.isFinite(metadata.quotedPrice)
      ? metadata.quotedPrice
      : null;
    if (clientQuote !== null && Math.abs(clientQuote - serverPrice) > 0.01) {
      console.warn(`⚠️  Price mismatch on upload (shop ${req.shop.id}): client quoted ${clientQuote}, server computed ${serverPrice}. Using server price.`);
    }

    // Server owns the id and the delete secret — never the client.
    const orderId = randomUUID();
    const deleteToken = randomBytes(16).toString("hex");

    const newOrder = {
      ...fromApiOrder({
        id: orderId,
        customerName: metadata.customerName || profile?.name || '',
        phoneNumber: metadata.phoneNumber || profile?.phone || '',
        notes: metadata.notes || '',
        fileName: metadata.fileName || req.file.originalname,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        uploadDate: new Date().toISOString(),
        status: 'PENDING',
        serverFileName: req.file.filename,
        pageCount,
        colorMode: metadata.printPreferences?.colorMode || 'color',
        copies: metadata.printPreferences?.copies || 1,
        paperType: metadata.printPreferences?.paperType || 'normal',
        totalPrice: serverPrice,
        source: 'upload',
        shopSyncStatus: 'pending',
      }),
      // Server-internal columns — never part of the canonical order shape, so
      // they are set here rather than routed through the mapper.
      shop_id: req.shop.id,
      user_id: req.userId || null,
      delete_token_hash: hashDeleteToken(deleteToken),
      auth_deferred: !!req.authDeferred,
    };

    // Recorded so the shop can block this sender later straight from the
    // order. Mapped fields, but never shown to a customer — every
    // customer-facing endpoint projects its columns explicitly.
    newOrder.uploader_ip = req.ip || null;
    newOrder.uploader_fingerprint = uploaderFingerprint(req);

    const { error } = await supabase.from('orders').insert(newOrder);
    if (error) throw error;

    // Return camelCase to the client via the same mapper, minus the
    // anti-abuse bookkeeping — the uploader has no business reading back what
    // we fingerprinted them with.
    const { uploaderIp, uploaderFingerprint: _fp, ...responseOrder } = toApiOrder(newOrder);
    res.status(200).json({ success: true, job: responseOrder, deleteToken });
  } catch (err) {
    // Clean up the orphaned temp file so a failed upload does not leak disk.
    if (req.file) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch { /* ignored */ }
    }
    // A malformed metadata JSON is the client's fault (400); anything else
    // (Supabase insert, pricing lookup, disk) is ours and must not masquerade
    // as a validation error, which made these failures undebuggable.
    const isClientError = err instanceof SyntaxError;
    console.error(`❌ Upload Error (${isClientError ? "client" : "server"}):`, err);
    res.status(isClientError ? 400 : 500).json({
      success: false,
      error: isClientError ? "Invalid upload metadata" : "Upload failed",
      detail: NODE_ENV === "production" ? undefined : err.message,
    });
  }
});

// Public order query — lookup by ID array for "my recent uploads"
app.post("/api/s/:shopSlug/orders/query", resolveShopBySlug, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(200).json([]);
  }
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('shop_id', req.shop.id)
    .in('id', ids)
    .order('uploaddate', { ascending: false });
  if (error) throw error;

  const sanitized = (orders || []).map(order => {
    const api = toApiOrder(order);
    // Public projection: no customerName / phoneNumber / notes / serverFileName.
    return {
      id: api.id,
      fileName: api.fileName,
      fileType: api.fileType,
      fileSize: api.fileSize,
      uploadDate: api.uploadDate,
      status: api.status,
      pageCount: api.pageCount,
      paperType: api.paperType || 'normal',
      colorMode: api.colorMode,
      copies: api.copies,
      source: api.source,
      totalPrice: api.totalPrice,
      printPreferences: {
        colorMode: api.colorMode,
        copies: api.copies,
        paperType: api.paperType || 'normal'
      },
      ...(order.status === 'rejected' ? { rejectionReason: order.rejection_reason } : {}),
    };
  });
  res.status(200).json(sanitized);
});

// Delete order — customer proves ownership with the per-upload deleteToken.
app.delete("/api/s/:shopSlug/orders/:id", deleteRateLimit, resolveShopBySlug, async (req, res) => {
  const orderId = req.params.id;
  const { deleteToken } = req.body || {};

  const { data: order, error } = await supabase.from('orders').select('*').eq('shop_id', req.shop.id).eq('id', orderId).single();
  if (error || !order) {
    return res.status(404).json({ success: false, error: "Order not found" });
  }

  const tokenOk = order.delete_token_hash && deleteToken &&
    hashDeleteToken(deleteToken) === order.delete_token_hash;
  if (!tokenOk) {
    return res.status(403).json({ success: false, error: "Not authorized to delete this order" });
  }

  if (order.serverfilename) {
    const filePath = path.join(UPLOADS_DIR, order.serverfilename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { console.warn("⚠️  Could not delete physical file"); }
  }

  await supabase.from('orders').delete().eq('shop_id', req.shop.id).eq('id', orderId);
  res.status(200).json({ success: true });
});

// Public file access by order ID
app.get("/api/s/:shopSlug/files/public/:id", resolveShopBySlug, async (req, res) => {
  try {
    const { data: order, error } = await supabase.from('orders').select('serverfilename, filename, filetype, status').eq('shop_id', req.shop.id).eq('id', req.params.id).single();
    if (error || !order || !order.serverfilename) {
      return res.status(404).json({ error: "File not found" });
    }
    if (["pending_review", "rejected", "REJECTED"].includes(order.status)) {
      return res.status(404).json({ error: "File not available" });
    }
    const filePath = path.resolve(path.join(UPLOADS_DIR, order.serverfilename));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (fs.existsSync(filePath)) {
      const safeName = (order.filename || "file").replace(/[^a-zA-Z0-9._-]/g, '_');
      const inline = /^image\//.test(order.filetype || "") || order.filetype === "application/pdf";
      res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`);
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Public logo access
app.get("/api/s/:shopSlug/logo", resolveShopBySlug, async (req, res) => {
  const settings = await getSettings(req.shop.id);
  const filename = settings._logo_filename;
  if (!filename) return res.status(404).json({ error: "No logo" });
  const filePath = path.resolve(path.join(UPLOADS_DIR, filename));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Logo not found" });
  }
  res.sendFile(filePath);
});

// Get settings (public — used by price calculator)
// Public shop directory — the platform root page uses it when no slug is given.
app.get("/api/shops", async (req, res) => {
  try {
    res.json(await listPublicShops());
  } catch (err) {
    console.error("❌ listPublicShops:", err);
    res.status(500).json({ error: "Failed to list shops" });
  }
});

app.get("/api/s/:shopSlug/settings", resolveShopBySlug, async (req, res) => {
  const settings = pickPublicSettings(await getSettings(req.shop.id));
  settings.paperTypes = await getPaperTypes(req.shop.id);
  res.status(200).json(settings);
});

// Full settings for the shop's own desktop app (shop token required)
app.get("/api/shop/settings", requireShopToken, async (req, res) => {
  const settings = await getSettings(req.shop.id);
  settings.paperTypes = await getPaperTypes(req.shop.id);
  // The desktop app needs the slug to build its public storefront links
  // (QR posters point at /s/:slug/upload, not the platform root).
  settings.shopSlug = req.shop.slug;
  res.status(200).json(settings);
});

// Get paper types (public)
app.get("/api/s/:shopSlug/paper-types", resolveShopBySlug, async (req, res) => {
  try {
    res.status(200).json(await getPaperTypes(req.shop.id));
  } catch (err) {
    console.error("❌ Error fetching paper types:", err);
    res.status(500).json({ error: "Failed to fetch paper types" });
  }
});

// Get discount rules (public reads)
app.get("/api/s/:shopSlug/discount-rules", resolveShopBySlug, async (req, res) => {
  try {
    const rules = await getDiscountRules(req.shop.id);
    res.status(200).json(rules);
  } catch (err) {
    console.error("❌ Error fetching discount rules:", err);
    res.status(500).json({ error: "Failed to fetch discount rules" });
  }
});

app.get("/api/s/:shopSlug/discount-rules/active", resolveShopBySlug, async (req, res) => {
  try {
    const rules = await getActiveDiscountRules(req.shop.id);
    res.status(200).json(rules);
  } catch (err) {
    console.error("❌ Error fetching active discount rules:", err);
    res.status(500).json({ error: "Failed to fetch active discount rules" });
  }
});

/**
 * CUSTOMER ACCOUNT API (authenticated with a Supabase customer JWT — global,
 * not shop-scoped: one account works across every shop on the platform)
 */

// Get the logged-in customer's profile (lazily created on first access)
app.get("/api/account/profile", requireCustomerAuth, async (req, res) => {
  try {
    let profile = await getProfileCamel(req.userId);
    if (!profile) {
      profile = await upsertProfile(req.userId, { email: req.userEmail || null });
    }
    res.status(200).json(profile);
  } catch (err) {
    console.error("❌ Error fetching profile:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update the logged-in customer's profile
app.put("/api/account/profile", requireCustomerAuth, async (req, res) => {
  try {
    const { name, phone, email, defaultPaperTypeId, defaultCopies } = req.body;
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (phone !== undefined) fields.phone = phone;
    if (email !== undefined) fields.email = email;
    if (defaultPaperTypeId !== undefined) fields.default_paper_type_id = defaultPaperTypeId;
    if (defaultCopies !== undefined) fields.default_copies = defaultCopies;

    const profile = await upsertProfile(req.userId, fields);
    res.status(200).json(profile);
  } catch (err) {
    console.error("❌ Error updating profile:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Get the logged-in customer's orders across all shops
app.get("/api/account/orders", requireCustomerAuth, async (req, res) => {
  try {
    const orders = await getCustomerOrders(req.userId);
    res.status(200).json(orders);
  } catch (err) {
    console.error("❌ Error fetching customer orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * SHOP-SYNC API (authenticated with SHOP_API_TOKEN)
 */

// Get pending orders (not yet claimed by shop)
app.get("/api/shop/pending", requireShopToken, async (req, res) => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('shop_id', req.shop.id)
    .eq('shopsyncstatus', 'pending')
    .order('uploaddate', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const camelOrders = (orders || []).map(order => {
    // Shop sync shape = the full order minus price/sync/rejection bookkeeping.
    const { totalPrice, shopSyncStatus, rejectionReason, ...pending } = toApiOrder(order);
    return pending;
  });
  res.status(200).json(camelOrders);
});

// ── Blocklist management (desktop Admin panel, shop token) ───────────────

app.get("/api/shop/blocks", requireShopToken, async (req, res) => {
  try {
    res.status(200).json(await listBlockedUploaders(req.shop.id));
  } catch (err) {
    console.error("\u274c Failed to list blocked uploaders:", err);
    res.status(500).json({ error: "Failed to list blocked uploaders" });
  }
});

app.post("/api/shop/blocks", requireShopToken, async (req, res) => {
  const { kind, value, reason, label } = req.body || {};
  if (!BLOCK_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${BLOCK_KINDS.join(", ")}` });
  }
  if (!normalizeBlockValue(kind, value)) {
    return res.status(400).json({ error: "value is required" });
  }
  try {
    res.status(200).json(await addBlockedUploader(req.shop.id, { kind, value, reason, label }));
  } catch (err) {
    console.error("\u274c Failed to block uploader:", err);
    res.status(500).json({ error: "Failed to block uploader" });
  }
});

app.delete("/api/shop/blocks/:id", requireShopToken, async (req, res) => {
  try {
    await removeBlockedUploader(req.shop.id, req.params.id);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("\u274c Failed to unblock uploader:", err);
    res.status(500).json({ error: "Failed to unblock uploader" });
  }
});

// Download file for a specific order
app.get("/api/shop/file/:orderId", requireShopToken, async (req, res) => {
  const { data: order, error } = await supabase.from('orders').select('*').eq('shop_id', req.shop.id).eq('id', req.params.orderId).single();
  if (error || !order) return res.status(404).json({ error: "Order not found" });
  if (!order.serverfilename) return res.status(404).json({ error: "No file for this order" });

  const filePath = path.resolve(path.join(UPLOADS_DIR, order.serverfilename));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) return res.status(403).json({ error: "Forbidden" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk" });

  const safeName = order.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.set("Content-Disposition", `attachment; filename="${safeName}"`);
  res.sendFile(filePath);
});

// Acknowledge/claim orders (shop has picked them up)
app.post("/api/shop/ack", requireShopToken, async (req, res) => {
  const { orderIds } = req.body;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: "orderIds array is required" });
  }
  const { error } = await supabase
    .from('orders')
    .update({ shopsyncstatus: 'claimed' })
    .eq('shop_id', req.shop.id)
    .in('id', orderIds)
    .eq('shopsyncstatus', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ success: true, claimed: orderIds.length });
});

// Reject a fetched-but-unclaimed order (shop reviewed it and declined it).
// Same resolving effect as ack — the order stops showing up in /api/shop/pending.
app.post("/api/shop/reject", requireShopToken, async (req, res) => {
  const { orderId, reason, note } = req.body;
  if (!orderId || !reason) {
    return res.status(400).json({ error: "orderId and reason are required" });
  }

  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('*')
    .eq('shop_id', req.shop.id)
    .eq('id', orderId)
    .single();
  if (fetchErr || !order) return res.status(404).json({ error: "Order not found" });

  const rejectionReason = note ? `${reason}: ${note}` : reason;

  const { error } = await supabase
    .from('orders')
    .update({ status: 'rejected', rejection_reason: rejectionReason, shopsyncstatus: 'claimed' })
    .eq('shop_id', req.shop.id)
    .eq('id', orderId);
  if (error) return res.status(500).json({ error: error.message });

  if (order.serverfilename) {
    const filePath = path.join(UPLOADS_DIR, order.serverfilename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { console.warn("⚠️  Could not delete rejected order's file"); }
  }

  broadcastStatusChange(orderId, 'rejected');
  res.status(200).json({ success: true });
});

// Update order status (e.g., "PRINTED") — pushed from shop.
// After updating the DB, push a live SSE event to any customer streams
// watching that order so their page reflects the change without a reload.
app.post("/api/shop/status", requireShopToken, async (req, res) => {
  const { orderId, status } = req.body;
  if (!orderId || !status) {
    return res.status(400).json({ error: "orderId and status are required" });
  }
  const { error } = await supabase.from('orders').update({ status }).eq('shop_id', req.shop.id).eq('id', orderId);
  if (error) return res.status(500).json({ error: error.message });
  broadcastStatusChange(orderId, status);
  res.status(200).json({ success: true });
});

// Sync settings/pricing/paper types/discount rules from shop
app.post("/api/shop/settings-sync", requireShopToken, async (req, res) => {
  try {
    const { pricing, paperTypes, discountRules } = req.body;
    const shopId = req.shop.id;

    if (pricing && typeof pricing === 'object') {
      await updateSetting(shopId, 'pricing', {
        colorPerPage: parseFloat(pricing.colorPerPage) || 30.0,
        blackWhitePerPage: parseFloat(pricing.blackWhitePerPage) || 15.0,
        glossyPerPage: parseFloat(pricing.glossyPerPage) || 50.0,
        cardboardPerPage: parseFloat(pricing.cardboardPerPage) || 40.0,
      });
    }
    if (pricing?.shopName) {
      await updateSetting(shopId, 'shopName', pricing.shopName);
    }
    if (pricing?.phoneNumbers) {
      await updateSetting(shopId, 'phoneNumbers', pricing.phoneNumbers);
    }
    if (pricing?.email) {
      await updateSetting(shopId, 'email', pricing.email);
    }
    if (pricing?.address) {
      await updateSetting(shopId, 'address', pricing.address);
    }
    if (pricing?.workingHours) {
      await updateSetting(shopId, 'workingHours', pricing.workingHours);
    }
    if (pricing?.returnPolicy) {
      await updateSetting(shopId, 'returnPolicy', pricing.returnPolicy);
    }
    if (pricing?.logoUrl) {
      await updateSetting(shopId, 'logoUrl', pricing.logoUrl);
    }
    if (typeof pricing?.autoAcceptCloudJobs === 'boolean') {
      await updateSetting(shopId, 'autoAcceptCloudJobs', pricing.autoAcceptCloudJobs);
    }

    if (Array.isArray(paperTypes)) {
      await replaceAllPaperTypes(shopId, paperTypes);
    }

    if (Array.isArray(discountRules)) {
      // Atomic replace via a single Postgres transaction (007_atomic_discount_sync).
      // A mid-sync failure can no longer leave the shop with half its rules.
      const { error: rpcErr } = await supabase.rpc('replace_shop_discount_rules', {
        p_shop_id: shopId,
        p_rules: discountRules,
      });
      if (rpcErr) throw rpcErr;
    }

    res.status(200).json({ success: true, shopSlug: req.shop.slug });
  } catch (err) {
    console.error("❌ Settings sync error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * CLEANUP JOB — delete claimed orders older than 7 days
 */
const cleanupOldOrders = async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: oldOrders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('shopsyncstatus', 'claimed')
      .lt('uploaddate', sevenDaysAgo);

    if (error) { console.error("❌ Cleanup query error:", error); return; }
    if (!oldOrders || oldOrders.length === 0) return;

    for (const order of oldOrders) {
      if (order.serverfilename) {
        const filePath = path.join(UPLOADS_DIR, order.serverfilename);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignored */ }
      }
      await supabase.from('orders').delete().eq('id', order.id);
    }
    console.log(`🧹 Cleaned up ${oldOrders.length} old claimed orders`);
  } catch (err) {
    console.error("❌ Cleanup error:", err);
  }
};

// Run cleanup daily
setInterval(cleanupOldOrders, 24 * 60 * 60 * 1000);
// Also run once at startup
setTimeout(cleanupOldOrders, 60_000);

/**
 * STATIC FILE SERVING & SPA ROUTING
 */
app.use(express.static(path.join(__dirname, 'public')));

if (!isDev) {
  app.use(
    express.static(DIST_DIR, {
      etag: true,
      setHeaders: (res, filePath) => {
        // Hashed asset filenames are safe to cache forever; index.html is not.
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

app.use((err, req, res, _next) => {
  console.error("❌ Unhandled Error:", err.stack);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: isDev ? err.message : "Internal Server Error" });
  }
});

if (!isDev) {
  app.use((req, res, _next) => {
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

// Under Vercel the app is imported by api/index.js and handled per-request —
// never call listen(). Exported at the bottom for that entry point.
if (!isVercel) {
  app.listen(PORT, HOST, () => {
    console.log("\n🚀 Atba3li Cloud started!");
    console.log(`📦 Environment: ${NODE_ENV}`);
    console.log(`🌐 Server URL: http://${HOST}:${PORT}`);
    if (isDev) {
      console.log(`🔧 Dev mode - CORS enabled for http://localhost:5000`);
    }
    console.log(`📂 Uploads directory: ${UPLOADS_DIR.replace(__dirname, '.')}`);
    console.log(`🗄️  Database: Supabase\n`);
  });
}

export { app };
export default app;
