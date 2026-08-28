import { describe, it, expect } from "vitest";
import { magicBytesMatch, isAllowedMime, ALLOWED_MIMES } from "../utils/fileValidation.js";

// Contract for Phase 4.2's packages/shared/src/validation.ts: the magic-byte
// matcher + MIME allowlist must keep exactly these accept/reject decisions.

const HEADERS: Record<string, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
  tiffLE: [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00],
  tiffBE: [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08],
  zip: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], // docx/xlsx container
};

describe("magicBytesMatch", () => {
  it("accepts correct magic per type", () => {
    expect(magicBytesMatch(HEADERS.pdf, "application/pdf")).toBe(true);
    expect(magicBytesMatch(HEADERS.png, "image/png")).toBe(true);
    expect(magicBytesMatch(HEADERS.jpeg, "image/jpeg")).toBe(true);
    expect(magicBytesMatch(HEADERS.tiffLE, "image/tiff")).toBe(true);
    expect(magicBytesMatch(HEADERS.tiffBE, "image/tiff")).toBe(true);
    expect(magicBytesMatch(HEADERS.zip, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(magicBytesMatch(HEADERS.zip, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
  });

  it("rejects wrong magic for a known type", () => {
    expect(magicBytesMatch(HEADERS.png, "application/pdf")).toBe(false);
    expect(magicBytesMatch(HEADERS.pdf, "image/png")).toBe(false);
    expect(magicBytesMatch(HEADERS.zip, "image/jpeg")).toBe(false);
  });

  it("skips the check (returns true) for an unknown MIME type", () => {
    expect(magicBytesMatch(HEADERS.pdf, "text/plain")).toBe(true);
    expect(magicBytesMatch([0x00, 0x01], "application/octet-stream")).toBe(true);
  });

  it("works on Buffer and Uint8Array too", () => {
    expect(magicBytesMatch(Buffer.from(HEADERS.pdf), "application/pdf")).toBe(true);
    expect(magicBytesMatch(Uint8Array.from(HEADERS.png), "image/png")).toBe(true);
  });
});

describe("isAllowedMime", () => {
  it("accepts the six upload types", () => {
    for (const m of ALLOWED_MIMES) expect(isAllowedMime(m)).toBe(true);
    expect(ALLOWED_MIMES.size).toBe(6);
  });

  it("rejects disallowed types", () => {
    expect(isAllowedMime("text/plain")).toBe(false);
    expect(isAllowedMime("application/x-msdownload")).toBe(false);
    expect(isAllowedMime("image/gif")).toBe(false);
    expect(isAllowedMime("application/zip")).toBe(false);
  });
});
