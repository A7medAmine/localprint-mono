import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import db, { getSettings, getPaperTypes, getDiscountRules } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function getConfig() {
  const s = getSettings();
  return {
    url: s.cloudSyncUrl || '',
    token: s.shopApiToken || '',
    pollInterval: parseInt(s.cloudSyncPollInterval || '30000', 10),
  };
}

const baseHeaders = {
  'Content-Type': 'application/json',
};

let syncTimer = null;
let isSyncing = false;

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
    returnPolicy: settings.returnPolicy || '',
    autoAcceptCloudJobs: settings.autoAcceptCloudJobs !== false,
  };

  const payload = {
    pricing,
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
        colorMode, copies, paperType, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      } catch (_) {}
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
    try { fs.unlinkSync(dl.filePath); } catch (_) {}
    return false;
  }
}

async function pollPending() {
  if (!isEnabled()) return;
  const cfg = getConfig();

  const res = await fetchWithRetry(`${cfg.url}/api/shop/pending`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res || !res.ok) {
    log('error', 'Failed to fetch pending orders', { status: res?.status });
    return;
  }

  let orders;
  try {
    orders = await res.json();
  } catch {
    log('error', 'Invalid JSON from pending endpoint');
    return;
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    return;
  }

  log('info', `Fetched ${orders.length} pending order(s)`);

  for (const order of orders) {
    await importOrder(order);
  }
}

export async function updateCloudStatus(orderId, status) {
  if (!isEnabled()) return false;
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

export async function startCloudSync() {
  if (!isEnabled()) {
    log('warn', 'Cloud sync disabled — configure Cloud Sync URL and API Token in Settings');
    return;
  }
  const cfg = getConfig();

  log('info', `Starting cloud sync, polling every ${cfg.pollInterval}ms`);

  const settingsOk = await syncSettings();
  if (!settingsOk) {
    log('warn', 'Initial settings sync failed — will retry on next poll');
  }

  await pollPending();

  syncTimer = setInterval(async () => {
    if (isSyncing) return;
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
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    log('info', 'Cloud sync stopped');
  }
}
