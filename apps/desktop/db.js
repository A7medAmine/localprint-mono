import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { checkEnv } from './checkEnv.js';
import { runMigrations } from './migrate.js';

checkEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ATBA3LI_DB_PATH is set by the Electron main process for packaged builds
// (so the DB lives under %APPDATA%\Atba3li\ instead of Program Files).
// Falls back to the repo-relative file for `npm run dev` / plain node.
const dbPath = process.env.ATBA3LI_DB_PATH || path.join(__dirname, 'database.sqlite');
let db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    customerName TEXT DEFAULT '',
    phoneNumber TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    fileName TEXT,
    fileType TEXT,
    fileSize INTEGER,
    uploadDate TEXT,
    status TEXT DEFAULT 'PENDING',
    serverFileName TEXT,
    pageCount INTEGER,
    colorMode TEXT DEFAULT 'color',
    copies INTEGER DEFAULT 1,
    paperType TEXT DEFAULT 'normal',
    source TEXT DEFAULT 'upload',
    customerEmail TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS paper_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    nameAr TEXT NOT NULL DEFAULT '',
    colorPerPage REAL NOT NULL DEFAULT 30,
    blackWhitePerPage REAL NOT NULL DEFAULT 15,
    sortOrder INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS discount_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL,
    discount_value REAL NOT NULL,
    condition_type TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    max_discount_cap REAL,
    priority INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS gmail_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_email TEXT DEFAULT '',
    access_token TEXT DEFAULT '',
    refresh_token TEXT DEFAULT '',
    token_expiry TEXT,
    connected_at TEXT,
    is_active INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS processed_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT UNIQUE NOT NULL,
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS gmail_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT UNIQUE NOT NULL,
    email_from TEXT,
    email_address TEXT,
    subject TEXT,
    body_preview TEXT,
    attachment_meta TEXT DEFAULT '[]',
    received_at TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Auto-create the singleton gmail_account row if it doesn't exist
const gmailRow = db.prepare('SELECT id FROM gmail_account WHERE id = 1').get();
if (!gmailRow) {
  db.prepare('INSERT INTO gmail_account (id) VALUES (1)').run();
}

// Migrations for columns added after initial schema — handled by numbered
// migration runner for new installs, but kept for existing databases that
// haven't run migrate.js yet (idempotent ADD COLUMN).
try { db.exec(`ALTER TABLE jobs ADD COLUMN customerEmail TEXT DEFAULT ''`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT DEFAULT 'upload'`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE gmail_pending ADD COLUMN discarded_at TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentStatus TEXT DEFAULT 'UNPAID'`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentAmount REAL`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentDate TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN cloudOrderId TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN gmailMessageId TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN notifiedReadyAt TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN deleteTokenHash TEXT`); } catch { /* ignored */ }
try { db.exec(`ALTER TABLE jobs ADD COLUMN orderId TEXT`); } catch { /* ignored */ }

runMigrations(db);

// Clean up ghost rows from the old client-supplied-id bug (see Phase 2.1):
// a row with a NULL id is unreachable from the admin UI. Remove their files too.
try {
  const uploadsDir = process.env.ATBA3LI_UPLOADS_DIR || path.join(__dirname, 'uploads');
  const orphans = db.prepare(`SELECT serverFileName FROM jobs WHERE id IS NULL`).all();
  for (const row of orphans) {
    if (!row.serverFileName) continue;
    try { fs.unlinkSync(path.join(uploadsDir, row.serverFileName)); } catch { /* ignored */ }
  }
  const del = db.prepare(`DELETE FROM jobs WHERE id IS NULL`).run();
  if (del.changes) console.warn(`🧹 Removed ${del.changes} ghost job row(s) with NULL id`);
} catch (e) { console.warn('⚠️  NULL-id job cleanup skipped:', e.message); }

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_imports (
    cloudOrderId TEXT PRIMARY KEY,
    localJobId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'imported',
    importedAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'custom',
    unit TEXT NOT NULL DEFAULT 'units',
    currentStock REAL NOT NULL DEFAULT 0,
    lowStockThreshold REAL NOT NULL DEFAULT 0,
    paperTypeId TEXT REFERENCES paper_types(id) ON DELETE SET NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    reason TEXT NOT NULL DEFAULT 'manual',
    note TEXT DEFAULT '',
    jobId TEXT,
    stockAfter REAL NOT NULL,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Customer account credentials saved for printing (registration-service
  -- shops: CNAS, e-Paiement, email, etc). password is stored encrypted (see
  -- encryptToken/decryptToken) — plaintext only ever exists in memory when a
  -- single record is fetched for editing or printing.
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    customerName TEXT NOT NULL,
    serviceName TEXT NOT NULL,
    websiteUrl TEXT DEFAULT '',
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    notice TEXT DEFAULT '',
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- The admin list reads jobs newest-first and the review queue filters on
  -- status; without these both are full table scans that grow with the shop.
  CREATE INDEX IF NOT EXISTS idx_jobs_uploadDate ON jobs(uploadDate DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_orderId ON jobs(orderId);

  CREATE INDEX IF NOT EXISTS idx_inventory_items_paperType ON inventory_items(paperTypeId);
  CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_itemId ON inventory_adjustments(itemId, createdAt DESC);

  CREATE INDEX IF NOT EXISTS idx_credentials_createdAt ON credentials(createdAt DESC);

  -- Customer CVs built and printed in-shop. The data column holds the full
  -- structured document (fields, sections, template, language) as JSON;
  -- fullName/phone are pulled out as real columns so reprint search stays a
  -- fast LIKE query.
  CREATE TABLE IF NOT EXISTS cv_profiles (
    id TEXT PRIMARY KEY,
    fullName TEXT NOT NULL,
    phone TEXT DEFAULT '',
    photoFilename TEXT DEFAULT '',
    data TEXT NOT NULL,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_cv_profiles_fullName ON cv_profiles(fullName);
  CREATE INDEX IF NOT EXISTS idx_cv_profiles_phone ON cv_profiles(phone);

  CREATE TABLE IF NOT EXISTS research_papers (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL DEFAULT 'middle',
    language    TEXT NOT NULL DEFAULT 'ar',
    data        TEXT NOT NULL DEFAULT '{}',
    createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_research_title ON research_papers(title);
  CREATE INDEX IF NOT EXISTS idx_research_subject ON research_papers(subject);

  -- 30-day disk cache of filtered/ranked image-search candidates, keyed by a
  -- hash of the normalized query. See migrations/005_image_search_cache.sql.
  CREATE TABLE IF NOT EXISTS image_search_cache (
    queryHash  TEXT PRIMARY KEY,
    query      TEXT NOT NULL,
    results    TEXT NOT NULL,
    fetchedAt  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default paper types if table is empty
const paperTypeCount = db.prepare('SELECT COUNT(*) AS count FROM paper_types').get();
if (paperTypeCount.count === 0) {
  const insert = db.prepare('INSERT INTO paper_types (id, name, nameAr, colorPerPage, blackWhitePerPage, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('normal', 'Normal', 'عادي', 30, 15, 0);
  insert.run('glossy', 'Glossy', 'لامع', 50, 50, 1);
  insert.run('cardboard', 'Cardboard', 'ورق مقوى', 40, 40, 2);
}

// Migrate legacy paperTypes from settings key-value if paper_types table has defaults only
const legacyPaperTypes = (() => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'paperTypes'").get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
})();
if (legacyPaperTypes && Array.isArray(legacyPaperTypes) && legacyPaperTypes.length > 0) {
  const currentCount = db.prepare('SELECT COUNT(*) AS count FROM paper_types').get();
  if (currentCount.count <= 3) {
    const insert = db.prepare('INSERT OR REPLACE INTO paper_types (id, name, nameAr, colorPerPage, blackWhitePerPage, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
    legacyPaperTypes.forEach((pt, idx) => {
      insert.run(pt.id, pt.name, pt.nameAr || pt.name, pt.colorPerPage, pt.blackWhitePerPage, idx);
    });
  }
  db.prepare("DELETE FROM settings WHERE key = 'paperTypes'").run();
}

/**
 * Settings Helpers
 */
export const getSettings = () => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(row => {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  });
  return settings;
};

export const updateSetting = (key, value) => {
  const serializedValue = (typeof value === 'object' || typeof value === 'boolean')
    ? JSON.stringify(value)
    : value;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, serializedValue);
};

export const getInternalState = (key) => {
  const row = db.prepare('SELECT value FROM internal_state WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
};

export const setInternalState = (key, value) => {
  const serializedValue = (typeof value === 'object' || typeof value === 'boolean')
    ? JSON.stringify(value)
    : value;
  db.prepare('INSERT OR REPLACE INTO internal_state (key, value) VALUES (?, ?)').run(key, serializedValue);
};

/**
 * Paper Types Helpers
 */
export const getPaperTypes = () => {
  return db.prepare('SELECT * FROM paper_types ORDER BY sortOrder ASC').all();
};

export const replaceAllPaperTypes = (types) => {
  const tx = db.transaction(() => {
    // Saving shop settings re-sends the whole paper type list, so this wipes and
    // rebuilds the table. inventory_items.paperTypeId is ON DELETE SET NULL, so
    // without snapshotting here every paper link would silently unlink on each
    // save. Links are restored for any type that still exists afterwards.
    const links = db.prepare('SELECT id, paperTypeId FROM inventory_items WHERE paperTypeId IS NOT NULL').all();

    db.prepare('DELETE FROM paper_types').run();
    const insert = db.prepare('INSERT INTO paper_types (id, name, nameAr, colorPerPage, blackWhitePerPage, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
    types.forEach((pt, idx) => {
      insert.run(pt.id, pt.name, pt.nameAr || pt.name, pt.colorPerPage, pt.blackWhitePerPage, idx);
    });

    const survivingIds = new Set(types.map(pt => pt.id));
    const relink = db.prepare('UPDATE inventory_items SET paperTypeId = ? WHERE id = ?');
    links.forEach(link => {
      if (survivingIds.has(link.paperTypeId)) relink.run(link.paperTypeId, link.id);
    });
  });
  tx();
};

export const createPaperType = (pt) => {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sortOrder), -1) AS maxOrder FROM paper_types').get();
  db.prepare('INSERT INTO paper_types (id, name, nameAr, colorPerPage, blackWhitePerPage, sortOrder) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pt.id, pt.name, pt.nameAr || pt.name, pt.colorPerPage, pt.blackWhitePerPage, maxOrder.maxOrder + 1);
  return db.prepare('SELECT * FROM paper_types WHERE id = ?').get(pt.id);
};

export const updatePaperType = (id, updates) => {
  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.nameAr !== undefined) { fields.push('nameAr = ?'); values.push(updates.nameAr); }
  if (updates.colorPerPage !== undefined) { fields.push('colorPerPage = ?'); values.push(updates.colorPerPage); }
  if (updates.blackWhitePerPage !== undefined) { fields.push('blackWhitePerPage = ?'); values.push(updates.blackWhitePerPage); }
  if (updates.sortOrder !== undefined) { fields.push('sortOrder = ?'); values.push(updates.sortOrder); }
  if (fields.length === 0) return null;
  values.push(id);
  db.prepare(`UPDATE paper_types SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM paper_types WHERE id = ?').get(id);
};

export const deletePaperType = (id) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM paper_types WHERE id = ?').run(id);
    // Re-index sortOrder
    const remaining = db.prepare('SELECT id FROM paper_types ORDER BY sortOrder ASC').all();
    const update = db.prepare('UPDATE paper_types SET sortOrder = ? WHERE id = ?');
    remaining.forEach((row, idx) => update.run(idx, row.id));
  });
  tx();
};

/**
 * Inventory Helpers
 *
 * Categories: 'paper' | 'ink_toner' | 'custom'. Only 'paper' items may carry a
 * paperTypeId, which is what enables auto-deduct on printed jobs — ink/toner and
 * custom items have no reliable per-job quantity, so they are manual-adjust only.
 */
export const INVENTORY_CATEGORIES = ['paper', 'ink_toner', 'custom'];
export const INVENTORY_REASONS = ['manual', 'restock', 'auto_deduct'];

export const getInventoryItems = () => {
  return db.prepare('SELECT * FROM inventory_items ORDER BY sortOrder ASC, createdAt ASC').all();
};

export const getInventoryItem = (id) => {
  return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
};

// Items sitting at or below their threshold. A threshold of 0 means "never warn".
export const getLowStockCount = () => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM inventory_items WHERE lowStockThreshold > 0 AND currentStock <= lowStockThreshold').get();
  return row.count;
};

export const createInventoryItem = (item) => {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sortOrder), -1) AS maxOrder FROM inventory_items').get();
  // Only paper items can be linked to a paper type.
  const paperTypeId = item.category === 'paper' ? (item.paperTypeId || null) : null;
  db.prepare(`
    INSERT INTO inventory_items (id, name, category, unit, currentStock, lowStockThreshold, paperTypeId, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.name,
    item.category,
    item.unit || 'units',
    item.currentStock || 0,
    item.lowStockThreshold || 0,
    paperTypeId,
    maxOrder.maxOrder + 1,
  );
  return getInventoryItem(item.id);
};

export const updateInventoryItem = (id, updates) => {
  const existing = getInventoryItem(id);
  if (!existing) return null;

  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.unit !== undefined) { fields.push('unit = ?'); values.push(updates.unit); }
  if (updates.currentStock !== undefined) { fields.push('currentStock = ?'); values.push(updates.currentStock); }
  if (updates.lowStockThreshold !== undefined) { fields.push('lowStockThreshold = ?'); values.push(updates.lowStockThreshold); }
  if (updates.sortOrder !== undefined) { fields.push('sortOrder = ?'); values.push(updates.sortOrder); }

  // Drop the paper link whenever the item is (or becomes) a non-paper category.
  const finalCategory = updates.category !== undefined ? updates.category : existing.category;
  if (updates.paperTypeId !== undefined || updates.category !== undefined) {
    const nextPaperTypeId = finalCategory === 'paper'
      ? (updates.paperTypeId !== undefined ? (updates.paperTypeId || null) : existing.paperTypeId)
      : null;
    fields.push('paperTypeId = ?');
    values.push(nextPaperTypeId);
  }

  if (fields.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE inventory_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getInventoryItem(id);
};

export const deleteInventoryItem = (id) => {
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  return id;
};

/**
 * Apply a signed stock change and record it in the audit log. Shared by the
 * manual/restock endpoint and the auto-deduct hook so every change is logged
 * the same way.
 *
 * Stock is floored at 0 — the logged amount is what was *actually* applied, so
 * a deduction larger than the remaining stock records the clamped value rather
 * than pretending a full deduction happened.
 *
 * @returns the updated item plus the adjustment row, or null if no such item.
 */
export const adjustInventoryStock = (id, { amount, reason, note, jobId } = {}) => {
  const tx = db.transaction(() => {
    const item = getInventoryItem(id);
    if (!item) return null;

    const nextStock = Math.max(0, item.currentStock + amount);
    const appliedAmount = nextStock - item.currentStock;

    db.prepare('UPDATE inventory_items SET currentStock = ? WHERE id = ?').run(nextStock, id);
    const result = db.prepare(`
      INSERT INTO inventory_adjustments (itemId, amount, reason, note, jobId, stockAfter)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, appliedAmount, reason || 'manual', note || '', jobId || null, nextStock);

    return {
      item: getInventoryItem(id),
      adjustment: db.prepare('SELECT * FROM inventory_adjustments WHERE id = ?').get(result.lastInsertRowid),
    };
  });
  return tx();
};

// True if this job already had an auto-deduct applied to this item. Used to
// keep applyAutoDeductForJob idempotent — toggling a job PRINTED→PENDING→PRINTED
// must not deduct stock twice.
export const hasAutoDeductForJob = (jobId, itemId) => {
  if (!jobId || !itemId) return false;
  return !!db.prepare(
    "SELECT 1 FROM inventory_adjustments WHERE jobId = ? AND itemId = ? AND reason = 'auto_deduct' LIMIT 1"
  ).get(jobId, itemId);
};

export const getInventoryAdjustments = (itemId, limit = 50) => {
  if (itemId) {
    return db.prepare('SELECT * FROM inventory_adjustments WHERE itemId = ? ORDER BY createdAt DESC, id DESC LIMIT ?').all(itemId, limit);
  }
  return db.prepare('SELECT * FROM inventory_adjustments ORDER BY createdAt DESC, id DESC LIMIT ?').all(limit);
};

// Paper items linked to a given paper type — the auto-deduct lookup. Returns an
// empty array when nothing is linked, which callers treat as "nothing to do".
export const getInventoryItemsByPaperType = (paperTypeId) => {
  if (!paperTypeId) return [];
  return db.prepare("SELECT * FROM inventory_items WHERE category = 'paper' AND paperTypeId = ?").all(paperTypeId);
};

/**
 * Discount Rules Helpers
 */
export const getDiscountRules = () => {
  const rows = db.prepare('SELECT * FROM discount_rules ORDER BY priority DESC, created_at DESC').all();
  return rows.map(row => ({ ...row, is_active: Boolean(row.is_active) }));
};

export const getActiveDiscountRules = () => {
  const rows = db.prepare('SELECT * FROM discount_rules WHERE is_active = 1 ORDER BY priority DESC').all();
  return rows.map(row => ({ ...row, is_active: Boolean(row.is_active) }));
};

export const createDiscountRule = (rule) => {
  const { id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap, priority, is_active } = rule;
  db.prepare(`
    INSERT INTO discount_rules (id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap, priority, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap || null, priority || 0, is_active ? 1 : 0);
  return rule;
};

export const updateDiscountRule = (id, updates) => {
  const fields = [];
  const values = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.discount_type !== undefined) { fields.push('discount_type = ?'); values.push(updates.discount_type); }
  if (updates.discount_value !== undefined) { fields.push('discount_value = ?'); values.push(updates.discount_value); }
  if (updates.condition_type !== undefined) { fields.push('condition_type = ?'); values.push(updates.condition_type); }
  if (updates.threshold !== undefined) { fields.push('threshold = ?'); values.push(updates.threshold); }
  if (updates.max_discount_cap !== undefined) { fields.push('max_discount_cap = ?'); values.push(updates.max_discount_cap); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
  if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active ? 1 : 0); }

  if (fields.length === 0) return null;

  values.push(id);
  db.prepare(`UPDATE discount_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { id, ...updates };
};

export const deleteDiscountRule = (id) => {
  db.prepare('DELETE FROM discount_rules WHERE id = ?').run(id);
  return id;
};

/**
 * Token Encryption Helpers
 */
const ENCRYPTION_KEY = (() => {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is required for token encryption');
  }
  return Buffer.from(keyHex, 'hex');
})();

export function encryptToken(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

export function decryptToken(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return '';
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}

/**
 * Gmail Account Helpers
 */
export const getGmailAccount = () => {
  const row = db.prepare('SELECT * FROM gmail_account WHERE id = 1').get();
  if (!row) return null;
  return {
    ...row,
    access_token: decryptToken(row.access_token),
    refresh_token: decryptToken(row.refresh_token),
  };
};

export const updateGmailTokens = ({ email, accessToken, refreshToken, expiryDate }) => {
  db.prepare(`
    UPDATE gmail_account 
    SET gmail_email = ?, access_token = ?, refresh_token = ?, token_expiry = ?, connected_at = CURRENT_TIMESTAMP, is_active = 1
    WHERE id = 1
  `).run(email || '', encryptToken(accessToken || ''), encryptToken(refreshToken || ''), expiryDate || null);
};

export const disconnectGmail = () => {
  db.prepare(`
    UPDATE gmail_account 
    SET gmail_email = '', access_token = '', refresh_token = '', token_expiry = NULL, is_active = 0
    WHERE id = 1
  `).run();
};

export const isEmailProcessed = (gmailMessageId) => {
  const row = db.prepare('SELECT id FROM processed_emails WHERE gmail_message_id = ?').get(gmailMessageId);
  return !!row;
};

export const markEmailProcessed = (gmailMessageId) => {
  db.prepare('INSERT OR IGNORE INTO processed_emails (gmail_message_id) VALUES (?)').run(gmailMessageId);
};

/**
 * Gmail Pending Emails (awaiting user review)
 */
export const getPendingEmails = () => {
  return db.prepare('SELECT * FROM gmail_pending WHERE discarded_at IS NULL ORDER BY fetched_at DESC').all();
};

export const isEmailPending = (gmailMessageId) => {
  const row = db.prepare('SELECT id FROM gmail_pending WHERE gmail_message_id = ?').get(gmailMessageId);
  return !!row;
};

export const addPendingEmail = ({ gmailMessageId, from, emailAddress, subject, bodyPreview, attachmentMeta, receivedAt }) => {
  db.prepare(`
    INSERT OR IGNORE INTO gmail_pending (gmail_message_id, email_from, email_address, subject, body_preview, attachment_meta, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gmailMessageId, from || '', emailAddress || '', subject || '', bodyPreview || '', JSON.stringify(attachmentMeta || []), receivedAt || null);
};

export const softDeletePendingEmail = (id) => {
  db.prepare("UPDATE gmail_pending SET discarded_at = datetime('now') WHERE id = ?").run(id);
};

export const restorePendingEmail = (id) => {
  db.prepare("UPDATE gmail_pending SET discarded_at = NULL WHERE id = ?").run(id);
};

export const removePendingEmail = (id) => {
  db.prepare('DELETE FROM gmail_pending WHERE id = ?').run(id);
};

export const getPendingEmailById = (id) => {
  const row = db.prepare('SELECT * FROM gmail_pending WHERE id = ?').get(id);
  if (row) row.attachment_meta = JSON.parse(row.attachment_meta || '[]');
  return row;
};

/**
 * Credential Helpers
 *
 * password is encrypted at rest (see encryptToken/decryptToken above —
 * reused rather than duplicated, since both need reversible storage for a
 * value that must be read back in plaintext). The list endpoint masks
 * the password so it never leaves the machine as anything but "••••••••"
 * until a single record is explicitly opened for edit/print.
 */
const MASKED_PASSWORD = "••••••••";

const maskCredential = (row) => ({ ...row, password: row.password ? MASKED_PASSWORD : "" });

const decryptCredential = (row) => ({ ...row, password: decryptToken(row.password) });

export const getCredentials = () => {
  return db.prepare('SELECT * FROM credentials ORDER BY createdAt DESC').all().map(maskCredential);
};

export const getCredential = (id) => {
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  return row ? decryptCredential(row) : null;
};

export const createCredential = (cred) => {
  db.prepare(`
    INSERT INTO credentials (id, customerName, serviceName, websiteUrl, username, password, notice)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    cred.id,
    cred.customerName,
    cred.serviceName,
    cred.websiteUrl || '',
    cred.username,
    encryptToken(cred.password),
    cred.notice || '',
  );
  return getCredential(cred.id);
};

export const updateCredential = (id, updates) => {
  const existing = db.prepare('SELECT id FROM credentials WHERE id = ?').get(id);
  if (!existing) return null;

  const fields = [];
  const values = [];
  if (updates.customerName !== undefined) { fields.push('customerName = ?'); values.push(updates.customerName); }
  if (updates.serviceName !== undefined) { fields.push('serviceName = ?'); values.push(updates.serviceName); }
  if (updates.websiteUrl !== undefined) { fields.push('websiteUrl = ?'); values.push(updates.websiteUrl || ''); }
  if (updates.username !== undefined) { fields.push('username = ?'); values.push(updates.username); }
  if (updates.password !== undefined) { fields.push('password = ?'); values.push(encryptToken(updates.password)); }
  if (updates.notice !== undefined) { fields.push('notice = ?'); values.push(updates.notice || ''); }

  if (fields.length === 0) return getCredential(id);

  values.push(id);
  db.prepare(`UPDATE credentials SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getCredential(id);
};

export const deleteCredential = (id) => {
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
  return id;
};

/**
 * Credential-card shop-wide settings: reusable "service" presets for the
 * add-card dropdown, a default notice printed on every card unless a
 * credential sets its own override, and a font-size scale (the printed card
 * looks sparse on a full A4/A5 sheet at the thermal-tuned default size).
 * Stored in the generic key-value `settings` table (same mechanism as
 * shopName/pricing/etc) rather than a dedicated table — no relational data
 * here, just a few blobs.
 */
const CREDENTIAL_FONT_SCALES = ['normal', 'large', 'xlarge'];

export const getCredentialSettings = () => {
  const settings = getSettings();
  return {
    services: Array.isArray(settings.credentialServices) ? settings.credentialServices : [],
    defaultNotice: typeof settings.credentialNotice === 'string' ? settings.credentialNotice : '',
    fontScale: CREDENTIAL_FONT_SCALES.includes(settings.credentialFontScale) ? settings.credentialFontScale : 'normal',
  };
};

export const updateCredentialSettings = ({ services, defaultNotice, fontScale }) => {
  if (services !== undefined) updateSetting('credentialServices', services);
  if (defaultNotice !== undefined) updateSetting('credentialNotice', defaultNotice || '');
  if (fontScale !== undefined && CREDENTIAL_FONT_SCALES.includes(fontScale)) updateSetting('credentialFontScale', fontScale);
  return getCredentialSettings();
};

/**
 * CV Profile Helpers
 *
 * `data` is the full structured document (fields toggles, sections, template,
 * language) stored as JSON — fullName/phone are duplicated as plain columns
 * purely so reprint search stays a fast indexed LIKE instead of scanning and
 * parsing JSON on every row.
 */
const parseCvRow = (row) => (row ? { ...row, data: JSON.parse(row.data || '{}') } : null);

export const getCvProfiles = (search) => {
  const rows = search
    ? db.prepare('SELECT * FROM cv_profiles WHERE fullName LIKE ? OR phone LIKE ? ORDER BY updatedAt DESC')
        .all(`%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM cv_profiles ORDER BY updatedAt DESC').all();
  return rows.map(parseCvRow);
};

export const getCvProfile = (id) => {
  const row = db.prepare('SELECT * FROM cv_profiles WHERE id = ?').get(id);
  return parseCvRow(row);
};

export const createCvProfile = (profile) => {
  db.prepare(`
    INSERT INTO cv_profiles (id, fullName, phone, data)
    VALUES (?, ?, ?, ?)
  `).run(
    profile.id,
    profile.fullName,
    profile.phone || '',
    JSON.stringify(profile.data || {}),
  );
  return getCvProfile(profile.id);
};

export const updateCvProfile = (id, updates) => {
  const existing = db.prepare('SELECT id FROM cv_profiles WHERE id = ?').get(id);
  if (!existing) return null;

  const fields = ["updatedAt = CURRENT_TIMESTAMP"];
  const values = [];
  if (updates.fullName !== undefined) { fields.push('fullName = ?'); values.push(updates.fullName); }
  if (updates.phone !== undefined) { fields.push('phone = ?'); values.push(updates.phone || ''); }
  if (updates.data !== undefined) { fields.push('data = ?'); values.push(JSON.stringify(updates.data)); }

  values.push(id);
  db.prepare(`UPDATE cv_profiles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getCvProfile(id);
};

// Used only by the photo upload/replace route — keeps the file-management
// concern (delete old file, store new filename) in the route, DB layer just
// records whatever filename it's given.
export const updateCvProfilePhoto = (id, photoFilename) => {
  db.prepare('UPDATE cv_profiles SET photoFilename = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(photoFilename || '', id);
  return getCvProfile(id);
};

export const deleteCvProfile = (id) => {
  db.prepare('DELETE FROM cv_profiles WHERE id = ?').run(id);
  return id;
};

/**
 * Research Paper Helpers
 *
 * Same shape as CV profiles: `data` holds the full structured document
 * (outline, sections, images, typography — see ResearchDocument in types.ts)
 * as JSON, while title/subject/level/language are duplicated as plain
 * columns so search and listing stay fast indexed lookups.
 */
const parseResearchRow = (row) => (row ? { ...row, data: JSON.parse(row.data || '{}') } : null);

export const getResearchPapers = (search) => {
  const rows = search
    ? db.prepare('SELECT * FROM research_papers WHERE title LIKE ? OR subject LIKE ? ORDER BY updatedAt DESC')
        .all(`%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM research_papers ORDER BY updatedAt DESC').all();
  return rows.map(parseResearchRow);
};

export const getResearchPaper = (id) => {
  const row = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
  return parseResearchRow(row);
};

export const createResearchPaper = (paper) => {
  db.prepare(`
    INSERT INTO research_papers (id, title, subject, level, language, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    paper.id,
    paper.title,
    paper.subject || '',
    paper.level || 'middle',
    paper.language || 'ar',
    JSON.stringify(paper.data || {}),
  );
  return getResearchPaper(paper.id);
};

export const updateResearchPaper = (id, updates) => {
  const existing = db.prepare('SELECT id FROM research_papers WHERE id = ?').get(id);
  if (!existing) return null;

  const fields = ["updatedAt = CURRENT_TIMESTAMP"];
  const values = [];
  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.subject !== undefined) { fields.push('subject = ?'); values.push(updates.subject || ''); }
  if (updates.level !== undefined) { fields.push('level = ?'); values.push(updates.level); }
  if (updates.language !== undefined) { fields.push('language = ?'); values.push(updates.language); }
  if (updates.data !== undefined) { fields.push('data = ?'); values.push(JSON.stringify(updates.data)); }

  values.push(id);
  db.prepare(`UPDATE research_papers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getResearchPaper(id);
};

// Unlinks every image file the paper references before deleting the row.
// Each unlink is guarded on its own — a missing file must not block the delete.
export const deleteResearchPaper = (id) => {
  const paper = getResearchPaper(id);
  if (paper?.data?.images?.length) {
    const uploadsDir = process.env.ATBA3LI_UPLOADS_DIR || path.join(__dirname, 'uploads');
    for (const image of paper.data.images) {
      if (!image?.filename) continue;
      try { fs.unlinkSync(path.join(uploadsDir, image.filename)); } catch { /* ignored */ }
    }
  }
  db.prepare('DELETE FROM research_papers WHERE id = ?').run(id);
  return id;
};

// ── Image search cache (phase 3) ──────────────────────────────────────────
// 30-day disk cache of the filtered/ranked ImageCandidate list per
// normalized query hash. Server-side only — see server/research/imageSearch.js.

export const getImageSearchCache = (queryHash) => {
  const row = db.prepare('SELECT * FROM image_search_cache WHERE queryHash = ?').get(queryHash);
  if (!row) return null;
  try {
    return { ...row, results: JSON.parse(row.results || '[]') };
  } catch {
    return null;
  }
};

export const setImageSearchCache = (queryHash, query, results) => {
  db.prepare(`
    INSERT INTO image_search_cache (queryHash, query, results, fetchedAt)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(queryHash) DO UPDATE SET
      query = excluded.query,
      results = excluded.results,
      fetchedAt = CURRENT_TIMESTAMP
  `).run(queryHash, query, JSON.stringify(results || []));
};

// Fold the WAL back into the main database file, then close.
// Do NOT delete the -wal / -shm files: if a checkpoint hasn't merged every
// frame (readers still open, checkpoint starved), removing the WAL discards
// those committed transactions. SQLite recreates and manages both files on
// the next open — leave them alone.
export function checkpointAndClose() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  try { db.close(); } catch { /* already closed */ }
}

export function reopenDb() {
  checkpointAndClose();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export { db as default };
