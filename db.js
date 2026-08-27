import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PRINTSHOP_DB_PATH is set by the Electron main process for packaged builds
// (so the DB lives under %APPDATA%\PrintShop Hub\ instead of Program Files).
// Falls back to the repo-relative file for `npm run dev` / plain node.
const dbPath = process.env.PRINTSHOP_DB_PATH || path.join(__dirname, 'database.sqlite');
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

// Migrations for columns added after initial schema
try { db.exec(`ALTER TABLE jobs ADD COLUMN customerEmail TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT DEFAULT 'upload'`); } catch (e) {}
try { db.exec(`ALTER TABLE gmail_pending ADD COLUMN discarded_at TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentStatus TEXT DEFAULT 'UNPAID'`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentAmount REAL`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN paymentDate TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN cloudOrderId TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN gmailMessageId TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN notifiedReadyAt TEXT`); } catch (e) {}

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

  CREATE INDEX IF NOT EXISTS idx_inventory_items_paperType ON inventory_items(paperTypeId);
  CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_itemId ON inventory_adjustments(itemId, createdAt DESC);
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
    } catch (e) {
      settings[row.key] = row.value;
    }
  });
  return settings;
};

export const updateSetting = (key, value) => {
  // better-sqlite3 only binds numbers/strings/bigints/buffers/null — booleans
  // (and objects) must be serialized first.
  const serializedValue = (typeof value === 'object' || typeof value === 'boolean')
    ? JSON.stringify(value)
    : value;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, serializedValue);
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

function encryptToken(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptToken(ciphertext) {
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

export function reopenDb() {
  try { db.close(); } catch (e) { /* already closed */ }
  for (const ext of ['-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export { db as default };
