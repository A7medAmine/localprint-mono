import 'dotenv/config';
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";
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
  rotateShopToken,
  updateShop,
  getSupabaseUserFromToken,
  AuthUnavailableError,
  getProfile,
  getProfileCamel,
  upsertProfile,
  getCustomerOrders,
} from './db.js';
import { ALLOWED_MIMES, magicBytesMatch } from '@localprint/shared/validation';
import { makeRateLimiter, securityHeaders } from '@localprint/shared/http';
import { countPdfPagesFromBuffer } from '@localprint/shared/pdf';
import { calculatePrintPrice, calculateJobDiscount } from '@localprint/shared/pricing';

// ── Magic byte validation ──
// Signature table + matcher live in @localprint/shared/validation (shared, tested).
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

// ── Platform-admin auth — a single shared bearer for the handful of shops. ──
const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || "";
function requirePlatformAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!PLATFORM_ADMIN_TOKEN) {
    return res.status(503).json({ error: "PLATFORM_ADMIN_TOKEN not configured" });
  }
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== PLATFORM_ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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

// ── Optional customer auth — attaches req.userId if a valid Supabase JWT is
// present, but never rejects the request. Guest requests (no/invalid token)
// pass through untouched. ──
async function optionalCustomerAuth(req, res, next) {
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

// ── Rate limiter (in-memory, per-IP): 5 requests / minute ──
// Factory shared with the desktop app (@localprint/shared/http). Keeps its own
// hit map + GC interval internally.
const rateLimit = makeRateLimiter({ windowMs: 60_000, max: 5 });

// ── Allowed MIME types for upload ──
// Set lives in @localprint/shared/validation (shared, tested); imported above.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV === "development";
const PORT = process.env.PORT || (isDev ? 5001 : 3000);

const DIST_DIR = path.join(__dirname, "dist");
const UPLOADS_DIR = path.join(__dirname, "uploads");

const app = express();

// Cloudflare + the box's reverse proxy sit in front — trust one proxy hop so
// req.ip is the real client (the rate limiter keys on it).
app.set("trust proxy", 1);

// Cap body sizes; file uploads go through multer, not these parsers.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

if (isDev) {
  const devOrigin = process.env.DEV_CORS_ORIGIN || "http://localhost:5000";
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", devOrigin);
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });
}

// Static security headers + the pdf.js-compatible CSP. connect-src also allows
// Supabase (customer auth + storage). Shared with the desktop app; see
// @localprint/shared/http for the CSP rationale.
app.use(securityHeaders({ connectSrc: ["'self'", "blob:", "https://*.supabase.co"] }));

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

  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepalive);
    for (const id of validIds) unsubscribeFromOrder(id, res);
  });
});

// Minimal platform-admin console (token pasted in the page, kept in-memory).
app.get("/platform-admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "platform-admin.html"));
});

// ── Platform-admin API (PLATFORM_ADMIN_TOKEN bearer) ──
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
app.post("/api/s/:shopSlug/upload", rateLimit, resolveShopBySlug, optionalCustomerAuthLenient, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const metadata = JSON.parse(req.body.metadata || "{}");
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

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
    // client uses (@localprint/shared/pricing) against this shop's real
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
      id: orderId,
      shop_id: req.shop.id,
      user_id: req.userId || null,
      delete_token_hash: hashDeleteToken(deleteToken),
      auth_deferred: !!req.authDeferred,
      customername: metadata.customerName || profile?.name || '',
      phonenumber: metadata.phoneNumber || profile?.phone || '',
      notes: metadata.notes || '',
      filename: metadata.fileName || req.file.originalname,
      filetype: req.file.mimetype,
      filesize: req.file.size,
      uploaddate: new Date().toISOString(),
      status: 'PENDING',
      serverfilename: req.file.filename,
      pagecount: pageCount,
      colormode: metadata.printPreferences?.colorMode || 'color',
      copies: metadata.printPreferences?.copies || 1,
      papertype: metadata.printPreferences?.paperType || 'normal',
      total_price: serverPrice,
      source: 'upload',
      shopsyncstatus: 'pending',
    };

    const { error } = await supabase.from('orders').insert(newOrder);
    if (error) throw error;

    // Return camelCase to the client
    const responseOrder = {
      id: orderId,
      customerName: newOrder.customername,
      phoneNumber: newOrder.phonenumber,
      notes: newOrder.notes,
      fileName: newOrder.filename,
      fileType: newOrder.filetype,
      fileSize: newOrder.filesize,
      uploadDate: newOrder.uploaddate,
      status: newOrder.status,
      serverFileName: newOrder.serverfilename,
      pageCount: newOrder.pagecount,
      colorMode: newOrder.colormode,
      copies: newOrder.copies,
      paperType: newOrder.papertype,
      totalPrice: newOrder.total_price,
      source: newOrder.source,
      shopSyncStatus: newOrder.shopsyncstatus,
    };
    res.status(200).json({ success: true, job: responseOrder, deleteToken });
  } catch (err) {
    console.error("❌ Upload Error:", err);
    res.status(400).json({ success: false, error: "Invalid upload metadata" });
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

  const sanitized = (orders || []).map(order => ({
    id: order.id,
    fileName: order.filename,
    fileType: order.filetype,
    fileSize: order.filesize,
    uploadDate: order.uploaddate,
    status: order.status,
    pageCount: order.pagecount,
    paperType: order.papertype || 'normal',
    colorMode: order.colormode,
    copies: order.copies,
    source: order.source,
    totalPrice: order.total_price,
    printPreferences: {
      colorMode: order.colormode,
      copies: order.copies,
      paperType: order.papertype || 'normal'
    },
    ...(order.status === 'rejected' ? { rejectionReason: order.rejection_reason } : {}),
  }));
  res.status(200).json(sanitized);
});

// Delete order — customer proves ownership with the per-upload deleteToken.
app.delete("/api/s/:shopSlug/orders/:id", resolveShopBySlug, async (req, res) => {
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
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.warn("⚠️  Could not delete physical file"); }
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
  } catch (err) {
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
app.get("/api/s/:shopSlug/settings", resolveShopBySlug, async (req, res) => {
  const settings = pickPublicSettings(await getSettings(req.shop.id));
  settings.paperTypes = await getPaperTypes(req.shop.id);
  res.status(200).json(settings);
});

// Full settings for the shop's own desktop app (shop token required)
app.get("/api/shop/settings", requireShopToken, async (req, res) => {
  const settings = await getSettings(req.shop.id);
  settings.paperTypes = await getPaperTypes(req.shop.id);
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

  const camelOrders = (orders || []).map(order => ({
    id: order.id,
    customerName: order.customername,
    phoneNumber: order.phonenumber,
    notes: order.notes,
    fileName: order.filename,
    fileType: order.filetype,
    fileSize: order.filesize,
    uploadDate: order.uploaddate,
    status: order.status,
    serverFileName: order.serverfilename,
    pageCount: order.pagecount,
    colorMode: order.colormode,
    copies: order.copies,
    paperType: order.papertype,
    source: order.source,
  }));
  res.status(200).json(camelOrders);
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
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.warn("⚠️  Could not delete rejected order's file"); }
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
      // supabase-js has no client-side transaction, so do this defensively:
      // snapshot the current rules, replace them, and restore the snapshot if
      // the insert fails — otherwise a bad insert leaves the shop with zero
      // discount rules.
      const rows = discountRules.map(r => ({
        ...r,
        shop_id: shopId,
        is_active: r.is_active ? 1 : 0,
        created_at: r.created_at || new Date().toISOString(),
      }));

      const { data: prevRules, error: readErr } = await supabase
        .from('discount_rules').select('*').eq('shop_id', shopId);
      if (readErr) throw readErr;

      const { error: delErr } = await supabase.from('discount_rules').delete().eq('shop_id', shopId);
      if (delErr && delErr.code !== 'PGRST116') throw delErr;

      if (rows.length > 0) {
        const { error: insErr } = await supabase.from('discount_rules').insert(rows);
        if (insErr) {
          // Roll back to the snapshot before surfacing the error.
          if (prevRules && prevRules.length > 0) {
            await supabase.from('discount_rules').delete().eq('shop_id', shopId);
            await supabase.from('discount_rules').insert(prevRules);
          }
          throw insErr;
        }
      }
    }

    res.status(200).json({ success: true });
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
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
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
  app.use(express.static(DIST_DIR, { maxAge: "1d", etag: true }));
}

app.use((err, req, res, next) => {
  console.error("❌ Unhandled Error:", err.stack);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: isDev ? err.message : "Internal Server Error" });
  }
});

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
  console.log("\n🚀 LocalPrint Cloud started!");
  console.log(`📦 Environment: ${NODE_ENV}`);
  console.log(`🌐 Server URL: http://${HOST}:${PORT}`);
  if (isDev) {
    console.log(`🔧 Dev mode - CORS enabled for http://localhost:5000`);
  }
  console.log(`📂 Uploads directory: ${UPLOADS_DIR.replace(__dirname, '.')}`);
  console.log(`🗄️  Database: Supabase\n`);
});
