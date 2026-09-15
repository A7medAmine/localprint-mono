import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALLOWED_MIMES, magicBytesMatch } from '@localprint/shared/validation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Same PRINTSHOP_UPLOADS_DIR override as server.js/db.js — in a packaged app
// __dirname sits inside the read-only asar archive.
const UPLOADS_BASE = process.env.PRINTSHOP_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

// Gmail itself caps attachments at 25MB; enforce the same bound locally so a
// hostile/oversized payload is never decoded into memory.
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

/**
 * Is this attachment worth downloading? Checks the MIME allowlist and the
 * size reported by the Gmail message metadata, so oversized or unsupported
 * parts are skipped BEFORE their base64 body is pulled into memory.
 * Returns null when acceptable, or a human-readable reason to skip.
 */
export function attachmentRejectReason(mimeType, reportedSize) {
  if (!ALLOWED_MIMES.has(mimeType)) {
    return `unsupported MIME type: ${mimeType}`;
  }
  if (Number(reportedSize) > MAX_ATTACHMENT_SIZE) {
    return `too large (${reportedSize} bytes, max ${MAX_ATTACHMENT_SIZE})`;
  }
  return null;
}

/**
 * Sanitize a filename: keep only safe characters.
 */
function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 200);
}

/**
 * Save a base64-encoded attachment to disk under uploads/YYYY/MM/DD/.
 * Applies the same three gates as the HTTP upload endpoints: MIME allowlist,
 * byte cap, and magic-byte match against the claimed MIME type.
 * Returns the relative path from uploads base, or null if rejected.
 */
export async function saveAttachment(filename, mimeType, base64Data, gmailMessageId) {
  if (!ALLOWED_MIMES.has(mimeType)) {
    console.warn(`⚠️  Rejected attachment with unsupported MIME type: ${mimeType}`);
    return null;
  }

  // Decoded length is derivable from the base64 length — check it before
  // allocating the buffer so an oversized body is never materialized.
  const b64 = String(base64Data || '');
  const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const approxBytes = Math.floor(b64.length * 3 / 4) - padding;
  if (approxBytes > MAX_ATTACHMENT_SIZE) {
    console.warn(`⚠️  Attachment too large (~${approxBytes} bytes): ${filename}`);
    return null;
  }

  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_ATTACHMENT_SIZE) {
    console.warn(`⚠️  Attachment too large (${buffer.length} bytes): ${filename}`);
    return null;
  }

  if (!magicBytesMatch(buffer.subarray(0, 16), mimeType)) {
    console.warn(`⚠️  Rejected attachment: content does not match declared type ${mimeType}: ${filename}`);
    return null;
  }

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const subDir = path.join(year, month, day);
  const dir = path.join(UPLOADS_BASE, subDir);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const safe = sanitizeFilename(filename);
  const safeName = `${Date.now()}_${safe}`;
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, buffer);

  return path.join(subDir, safeName);
}

/**
 * Get the full file path from a relative path.
 */
export function getAttachmentFullPath(relativePath) {
  return path.join(UPLOADS_BASE, relativePath);
}
