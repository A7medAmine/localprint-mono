/**
 * Pure file-validation primitives: magic-byte signatures and the MIME
 * allowlist. Dependency-free (no fs, no db) so both apps' upload paths and
 * their unit tests can import it directly. Server-side code loads this via the
 * "@localprint/shared/validation" subpath, which resolves to this real .js
 * file — plain Node can't import the package's TypeScript index entry.
 */

// ── Magic byte signatures, keyed by claimed MIME type ──
// Each value is a list of acceptable leading-byte sequences (a file matches if
// ANY sequence is a prefix of its header).
export const MAGIC_BYTES = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/jpeg": [[0xFF, 0xD8, 0xFF]],
  "image/png": [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  "image/tiff": [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4B, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4B, 0x03, 0x04]],
};

// ── MIME types the upload endpoints accept ──
export const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function isAllowedMime(mimeType) {
  return ALLOWED_MIMES.has(mimeType);
}

/**
 * Does the file header `head` match the magic bytes expected for `mimeType`?
 * `head` is any indexable byte sequence (Buffer / Uint8Array / number[]).
 * Unknown MIME types return true (the check is skipped, matching the original
 * server behavior — the MIME allowlist is the gate for those).
 */
export function magicBytesMatch(head, mimeType) {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return true; // unknown type, skip check
  return signatures.some(sig => sig.every((byte, i) => head[i] === byte));
}
