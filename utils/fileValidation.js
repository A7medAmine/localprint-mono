// Pure file-validation primitives shared by the upload path. Extracted from
// server.js so the magic-byte and MIME checks can be unit-tested directly and
// (Phase 4.2) moved into packages/shared. Kept byte-for-byte identical to the
// desktop copy so both apps validate uploads the same way.
export const MAGIC_BYTES = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/jpeg": [[0xFF, 0xD8, 0xFF]],
  "image/png": [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  "image/tiff": [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4B, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4B, 0x03, 0x04]],
};

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

// `head` is the leading bytes of the file (>= the longest signature). Types we
// have no signature for pass through — the MIME allowlist is the gate there.
export function magicBytesMatch(head, mimeType) {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return true; // unknown type, skip check
  return signatures.some(sig => sig.every((byte, i) => head[i] === byte));
}
