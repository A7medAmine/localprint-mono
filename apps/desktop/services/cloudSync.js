import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import db, { getSettings, getPaperTypes, getDiscountRules, updateSetting, getInternalState, setInternalState } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Packaged builds run this file from inside app.asar (read-only) while the
// real uploads live in the per-user data folder, so honour the same
// ATBA3LI_UPLOADS_DIR override server.js and db.js use. Without it every
// downloaded cloud order failed to write and no order ever landed.
const UPLOADS_DIR = process.env.ATBA3LI_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

// Legacy rows can still hold a full storefront link (…/s/<slug>/upload); the
// API lives at the platform root, so trim anything from /s/ onwards.
function apiBase(raw) {
  return String(raw || '').trim().replace(/\/s\/[^/?#]+.*$/i, '').replace(/\/+$/, '');
}

function getConfig() {
  const s = getSettings();
  return {
    url: apiBase(s.cloudSyncUrl),
    token: s.shopApiToken || '',
    pollInterval: parseInt(s.cloudSyncPollInterval || '30000', 10),
  };
}

const baseHeaders = {
  'Content-Type': 'application/json',
};

let syncTimer = null;
let isSyncing = false;
// Bumped by every start/stop. A start that awaits its initial sync can be
// superseded (settings saved twice, stop called mid-start); if the generation
// moved on while it was awaiting, it must not arm a timer — otherwise every
// superseded start leaves a live interval behind and the poll rate multiplies.
let syncGeneration = 0;
// Consecutive auth rejections (401/403). A bad token is not transient, so the
// poller backs off instead of hammering the cloud once per interval forever.
let authFailures = 0;
const MAX_AUTH_FAILURES = 3;

let newJobCallback = null;
export function setNewJobCallback(fn) {
  newJobCallback = fn;
}

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const prefix = `[☁️ CloudSync ${ts}]`;
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  if (level === 'error') {
    console.error(`${prefix} ❌ ${msg}${extra}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️  ${msg}${extra}`);
  } else {
    console.log(`${prefix} ${msg}${extra}`);
  }
}

export function isEnabled() {
  const cfg = getConfig();
  if (!cfg.url || !cfg.token) {
    return false;
  }
  return true;
}

// One-shot connectivity probe for the Settings → Cloud Sync "Test" buttons.
// Deliberately NOT fetchWithRetry: the operator is waiting on a button, so a
// bad URL must fail in seconds instead of burning four attempts with backoff.
// Values can be passed in so the UI can test unsaved draft fields; anything
// omitted falls back to what is stored.
export async function testConnection(overrides = {}) {
  const cfg = getConfig();
  const url = apiBase(overrides.url !== undefined ? overrides.url : cfg.url);
  const token = String(overrides.token !== undefined ? overrides.token : cfg.token || '').trim();

  if (!url) return { ok: false, stage: 'config', error: 'missing_url' };
  if (!token) return { ok: false, stage: 'config', error: 'missing_token' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(`${url}/api/shop/settings`, {
      headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    log('warn', 'Connection test could not reach the cloud', { url, error: err.message });
    return {
      ok: false,
      stage: 'network',
      error: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      message: err.message,
    };
  }
  clearTimeout(timer);

  if (res.status === 401) return { ok: false, stage: 'auth', status: 401, error: 'bad_token' };
  if (res.status === 403) return { ok: false, stage: 'auth', status: 403, error: 'shop_deactivated' };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, stage: 'server', status: res.status, message: body.slice(0, 200) };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    return { ok: false, stage: 'server', status: res.status, error: 'bad_response' };
  }

  log('info', 'Connection test succeeded', { url, shopSlug: body?.shopSlug });
  return {
    ok: true,
    stage: 'ok',
    status: res.status,
    shopSlug: typeof body?.shopSlug === 'string' ? body.shopSlug : '',
    shopName: typeof body?.shopName === 'string' ? body.shopName : '',
  };
}

async function fetchWithRetry(url, options = {}, retries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...baseHeaders, ...options.headers },
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      log('warn', `HTTP ${res.status} from ${url}`, { body: body.slice(0, 200) });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      log('warn', `Fetch attempt ${attempt + 1}/${retries + 1} failed for ${url}`, { error: err.message });
    }
    if (attempt < retries) {
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

// The logo lives on this machine as a file under UPLOADS_DIR, and the local
// `logoUrl` setting is `/api/logo` — a path that only resolves against the
// desktop server. Sending that string to the cloud is what left every
// storefront and the public directory with a broken image. Send the bytes
// instead, as a data URL the cloud can store and re-serve.
const MAX_SYNCED_LOGO_BYTES = 256 * 1024;

const LOGO_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * The current logo as a data URL, or null when the shop has none.
 * Returns undefined when the file is unreadable or too big — the caller then
 * leaves the cloud copy alone rather than clearing a logo over a read error.
 */
function readLocalLogo() {
  const filename = getInternalState('_logo_filename');
  if (!filename) return null;
  const filePath = path.resolve(path.join(UPLOADS_DIR, String(filename)));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SYNCED_LOGO_BYTES) {
      log('warn', 'Logo too large to sync — skipping', { bytes: stat.size, max: MAX_SYNCED_LOGO_BYTES });
      return undefined;
    }
    const mime = LOGO_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!mime) {
      log('warn', 'Unsupported logo file type — skipping', { file: path.extname(filePath) });
      return undefined;
    }
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch (err) {
    log('warn', 'Could not read logo for sync', { error: err.message });
    return undefined;
  }
}

export async function syncSettings() {
  const cfg = getConfig();
  const settings = getSettings();
  const paperTypes = getPaperTypes();
  const discountRules = getDiscountRules();

  const pricing = {
    colorPerPage: settings.pricing?.colorPerPage ?? 30,
    blackWhitePerPage: settings.pricing?.blackWhitePerPage ?? 15,
    glossyPerPage: settings.pricing?.glossyPerPage ?? 50,
    cardboardPerPage: settings.pricing?.cardboardPerPage ?? 40,
    shopName: settings.shopName || '',
    phoneNumbers: settings.phoneNumbers || [],
    email: settings.email || '',
    address: settings.address || '',
    workingHours: settings.workingHours || '',
    location: settings.location || null,
    returnPolicy: settings.returnPolicy || '',
    autoAcceptCloudJobs: settings.autoAcceptCloudJobs !== false,
  };

  // Settings sync runs on every save and on a timer; re-uploading the same
  // ~100KB image each time would be pure waste, so the logo rides along only
  // when it actually changed since the last accepted sync.
  const logoDataUrl = readLocalLogo();
  const logoFingerprint = logoDataUrl === undefined
    ? undefined
    : (logoDataUrl === null ? 'none' : createHash('sha256').update(logoDataUrl).digest('hex'));
  const logoChanged = logoFingerprint !== undefined
    && logoFingerprint !== getInternalState('_cloud_logo_fingerprint');

  const payload = {
    pricing,
    ...(logoChanged ? { logo: logoDataUrl } : {}),
    paperTypes: paperTypes.map(pt => ({
      id: pt.id,
      name: pt.name,
      nameAr: pt.nameAr,
      colorPerPage: pt.colorPerPage,
      blackWhitePerPage: pt.blackWhitePerPage,
    })),
    discountRules: discountRules.map(r => ({
      id: r.id,
      name: r.name,
      discount_type: r.discount_type,
      discount_value: r.discount_value,
      condition_type: r.condition_type,
      threshold: r.threshold,
      max_discount_cap: r.max_discount_cap,
      priority: r.priority,
      is_active: r.is_active,
    })),
  };

  const res = await fetchWithRetry(`${cfg.url}/api/shop/settings-sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { ...baseHeaders, Authorization: `Bearer ${cfg.token}` },
  });

  if (res && res.ok) {
    log('info', 'Settings synced to cloud');
    if (logoChanged) {
      // Only after the cloud accepted it — a failed sync must retry the upload.
      setInternalState('_cloud_logo_fingerprint', logoFingerprint);
      log('info', 'Logo pushed to cloud', { cleared: logoDataUrl === null });
    }
    // The cloud owns the shop slug; cache it locally so the QR poster can
    // link to this shop's storefront (/s/<slug>/upload) instead of the
    // platform root.
    try {
      const body = await res.json();
      const slug = typeof body?.shopSlug === 'string' ? body.shopSlug.trim() : '';
      if (slug && slug !== settings.cloudShopSlug) {
        updateSetting('cloudShopSlug', slug);
        log('info', 'Cached shop slug from cloud', { slug });
      }
    } catch {
      // Older cloud builds answer with an empty body — keep whatever slug we have.
    }
    return true;
  }
  log('error', 'Failed to sync settings', { status: res?.status });
  return false;
}

async function downloadFile(orderId, serverFileName) {
  const cfg = getConfig();
  const res = await fetchWithRetry(`${cfg.url}/api/shop/file/${orderId}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (!res || !res.ok) {
    log('error', `Failed to download file for order ${orderId}`, { status: res?.status });
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(serverFileName) || '.pdf';
  const localFilename = randomBytes(16).toString('hex') + ext;
  const filePath = path.join(UPLOADS_DIR, localFilename);

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  fs.writeFileSync(filePath, buffer);
  log('info', `Downloaded file for order ${orderId}`, { localFilename, size: buffer.length });
  return { localFilename, filePath, buffer };
}

export async function acknowledgeOrder(orderId) {
  const cfg = getConfig();
  const res = await fetchWithRetry(`${cfg.url}/api/shop/ack`, {
    method: 'POST',
    body: JSON.stringify({ orderIds: [orderId] }),
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (res && res.ok) {
    log('info', `Acknowledged order ${orderId}`);
    return true;
  }
  log('error', `Failed to ack order ${orderId}`, { status: res?.status });
  return false;
}

export async function rejectCloudOrder(orderId, reason, note) {
  const cfg = getConfig();
  const res = await fetchWithRetry(`${cfg.url}/api/shop/reject`, {
    method: 'POST',
    body: JSON.stringify({ orderId, reason, note }),
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (res && res.ok) {
    log('info', `Rejected cloud order ${orderId}`, { reason });
    return true;
  }
  log('error', `Failed to reject cloud order ${orderId}`, { status: res?.status });
  return false;
}

async function importOrder(order) {
  const orderId = order.id;

  const existing = db.prepare('SELECT id, status FROM jobs WHERE id = ? OR cloudOrderId = ?').get(orderId, orderId);
  if (existing) {
    if (existing.status === 'pending_review') {
      // Awaiting the shop's accept/reject decision — must stay un-acked on the
      // cloud (that's the whole point of the review step), so do nothing.
      return false;
    }
    log('warn', `Order ${orderId} already exists locally, skipping`);
    await acknowledgeOrder(orderId);
    return false;
  }

  log('info', `Importing order ${orderId}`, { customer: order.customerName, file: order.fileName });

  const dl = await downloadFile(orderId, order.serverFileName);
  if (!dl) return false;

  const pageCount = order.pageCount || null;
  const colorMode = (order.colorMode === 'color' || order.colorMode === 'blackWhite') ? order.colorMode : 'color';
  const copies = (typeof order.copies === 'number' && order.copies >= 1) ? order.copies : 1;
  const paperType = order.paperType || 'normal';

  const settings = getSettings();
  const autoAccept = settings.autoAcceptCloudJobs !== false;

  try {
    db.prepare(`
      INSERT INTO jobs (
        id, cloudOrderId, customerName, phoneNumber, notes, fileName, fileType,
        fileSize, uploadDate, status, serverFileName, pageCount,
        colorMode, copies, paperType, source, uploaderIp, uploaderFingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      orderId,
      order.customerName || '',
      order.phoneNumber || '',
      order.notes || '',
      order.fileName || 'unknown.pdf',
      order.fileType || 'application/pdf',
      order.fileSize || dl.buffer.length,
      order.uploadDate || new Date().toISOString(),
      autoAccept ? 'PENDING' : 'pending_review',
      dl.localFilename,
      pageCount,
      colorMode,
      copies,
      paperType,
      'cloud-sync',
      // Anti-abuse identifiers the cloud captured at upload time; used only by
      // the Admin panel's "block this uploader" action.
      order.uploaderIp || null,
      order.uploaderFingerprint || null,
    );

    log('info', `Imported order ${orderId} into local jobs`, { autoAccept });

    if (newJobCallback) {
      try {
        newJobCallback({
          id: orderId,
          customerName: order.customerName || '',
          fileName: order.fileName || 'unknown.pdf',
          pendingReview: !autoAccept,
        });
      } catch { /* ignored */ }
    }

    if (autoAccept) {
      const acked = await acknowledgeOrder(orderId);
      if (!acked) {
        log('warn', `Order ${orderId} imported but ack failed — will retry`);
      }
    } else {
      log('info', `Order ${orderId} awaiting shop review — not acknowledged yet`);
    }
    return true;
  } catch (err) {
    log('error', `Failed to insert job for order ${orderId}`, { error: err.message });
    try { fs.unlinkSync(dl.filePath); } catch { /* ignored */ }
    return false;
  }
}

async function pollPending() {
  if (!isEnabled()) return 0;
  const cfg = getConfig();

  const res = await fetchWithRetry(`${cfg.url}/api/shop/pending`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res || !res.ok) {
    if (res?.status === 401 || res?.status === 403) {
      authFailures++;
      if (authFailures >= MAX_AUTH_FAILURES) {
        log('error', `Cloud rejected the shop API token ${authFailures} times — polling paused. Re-enter the token in Settings.`);
      }
    }
    log('error', 'Failed to fetch pending orders', { status: res?.status });
    throw new Error(`Pending fetch failed with status ${res?.status || 'no response'}`);
  }

  authFailures = 0;

  let orders;
  try {
    orders = await res.json();
  } catch {
    log('error', 'Invalid JSON from pending endpoint');
    throw new Error('Invalid JSON from pending endpoint');
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    return 0;
  }

  log('info', `Fetched ${orders.length} pending order(s)`);

  let imported = 0;
  for (const order of orders) {
    // One bad order (unwritable uploads dir, DB constraint, malformed row)
    // must not abort the whole cycle — an uncaught throw here used to kill
    // startCloudSync before it ever armed the poll timer, so cloud sync
    // stayed dead until the app restarted.
    try {
      if (await importOrder(order)) imported++;
    } catch (err) {
      log('error', `Import failed for order ${order?.id}`, { error: err.message });
    }
  }
  return imported;
}

/**
 * Run one poll cycle on demand — the Job Review panel's "Check for orders"
 * button. Shares the `isSyncing` guard with the interval timer so a manual
 * check can never overlap a scheduled one (double-importing an order).
 * Returns how many new orders were imported.
 */
export async function pollNow() {
  if (!isEnabled()) throw new Error('Cloud sync is not configured');
  if (isSyncing) return 0;
  isSyncing = true;
  try {
    return await pollPending();
  } finally {
    isSyncing = false;
  }
}

export async function updateCloudStatus(orderId, status) {
  if (!isEnabled()) return false;
  // Operator-made jobs (source: "admin") are local-only and never cloud-synced.
  const job = db.prepare('SELECT source FROM jobs WHERE cloudOrderId = ?').get(orderId);
  if (job && job.source === 'admin') return false;
  const cfg = getConfig();

  const res = await fetchWithRetry(`${cfg.url}/api/shop/status`, {
    method: 'POST',
    body: JSON.stringify({ orderId, status }),
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (res && res.ok) {
    log('info', `Updated status for order ${orderId}`, { status });
    return true;
  }
  log('error', `Failed to update status for order ${orderId}`, { status, httpStatus: res?.status });
  return false;
}

/**
 * Upload blocklist, proxied to the cloud's shop-token API.
 *
 * The list is the cloud's to own — enforcement happens there, on the public
 * upload endpoint — so nothing is mirrored locally. Each call is a thin
 * pass-through that surfaces the cloud's own error text to the operator.
 */
async function blocksRequest(method, pathSuffix = '', body) {
  if (!isEnabled()) throw new Error('Cloud sync is not configured');
  const cfg = getConfig();
  const res = await fetchWithRetry(`${cfg.url}/api/shop/blocks${pathSuffix}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res || !res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* ignored */ }
    throw new Error(detail || `Blocklist request failed (${res?.status || 'no response'})`);
  }
  return res.json();
}

export async function listBlockedUploaders() {
  return blocksRequest('GET');
}

export async function blockUploader({ kind, value, reason, label }) {
  return blocksRequest('POST', '', { kind, value, reason, label });
}

export async function unblockUploader(id) {
  return blocksRequest('DELETE', `/${encodeURIComponent(id)}`);
}

export async function startCloudSync() {
  // Any previous timer (and any start still awaiting its initial sync) is
  // superseded by this call.
  stopCloudSync();
  const generation = ++syncGeneration;
  authFailures = 0;

  if (!isEnabled()) {
    log('warn', 'Cloud sync disabled — configure Cloud Sync URL and API Token in Settings');
    return;
  }
  const cfg = getConfig();

  log('info', `Starting cloud sync, polling every ${cfg.pollInterval}ms`);

  try {
    const settingsOk = await syncSettings();
    if (!settingsOk) {
      log('warn', 'Initial settings sync failed — will retry on next poll');
    }
  } catch (err) {
    log('error', 'Initial settings sync threw', { error: err.message });
  }

  // Arm the timer even if the first poll blows up; a transient startup failure
  // must not leave the app permanently offline from the cloud.
  try {
    await pollPending();
  } catch (err) {
    log('error', 'Initial poll failed', { error: err.message });
  }

  if (generation !== syncGeneration) {
    log('info', 'Cloud sync start superseded — not arming timer');
    return;
  }

  syncTimer = setInterval(async () => {
    if (isSyncing) return;
    if (authFailures >= MAX_AUTH_FAILURES) return;
    isSyncing = true;
    try {
      await pollPending();
    } catch (err) {
      log('error', 'Poll cycle error', { error: err.message });
    } finally {
      isSyncing = false;
    }
  }, cfg.pollInterval);
}

export function stopCloudSync() {
  syncGeneration++;
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    log('info', 'Cloud sync stopped');
  }
}
