import { describe, it, expect } from "vitest";
import { isAllowedMime, magicBytesMatch } from "@atba3li/shared/validation";

describe("isAllowedMime", () => {
  it("accepts known upload types", () => {
    expect(isAllowedMime("application/pdf")).toBe(true);
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("image/jpeg")).toBe(true);
  });

  it("rejects unknown types", () => {
    expect(isAllowedMime("application/x-msdownload")).toBe(false);
    expect(isAllowedMime("text/html")).toBe(false);
    expect(isAllowedMime("")).toBe(false);
  });
});

describe("magicBytesMatch", () => {
  it("matches a real PDF header", () => {
    const head = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(magicBytesMatch(head, "application/pdf")).toBe(true);
  });

  it("rejects a wrong header for a known type", () => {
    const head = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
    expect(magicBytesMatch(head, "application/pdf")).toBe(false);
  });

  it("matches either TIFF byte-order mark", () => {
    expect(magicBytesMatch(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), "image/tiff")).toBe(true);
    expect(magicBytesMatch(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a]), "image/tiff")).toBe(true);
  });

  it("passes through a type with no known signature", () => {
    // no signature entry -> the MIME allowlist is the gate, not the bytes
    expect(magicBytesMatch(Uint8Array.from([0x00]), "application/zip")).toBe(true);
  });
});
