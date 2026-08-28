import { describe, it, expect } from "vitest";
import { makeTokenCache, isRejectedTokenError } from "../utils/authCache.js";

describe("makeTokenCache", () => {
  it("returns undefined for a token it has never seen", () => {
    const cache = makeTokenCache({ now: () => 0 });
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns the cached user within the TTL", () => {
    let t = 1000;
    const cache = makeTokenCache({ now: () => t, ttlMs: 60_000 });
    cache.set("tok", { id: "u1" });
    t = 30_000;
    expect(cache.get("tok")).toEqual({ id: "u1" });
  });

  it("evicts once the TTL has passed", () => {
    let t = 0;
    const cache = makeTokenCache({ now: () => t, ttlMs: 60_000 });
    cache.set("tok", { id: "u1" });
    t = 60_001;
    expect(cache.get("tok")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("never outlives the token's own exp claim", () => {
    let t = 0;
    const cache = makeTokenCache({ now: () => t, ttlMs: 60_000 });
    // exp is 10s out -> TTL clamps to 10s, not the full 60s
    cache.set("tok", { id: "u1" }, 10);
    t = 11_000;
    expect(cache.get("tok")).toBeUndefined();
  });

  it("skips caching a token that is already past its exp", () => {
    const cache = makeTokenCache({ now: () => 100_000, ttlMs: 60_000 });
    cache.set("tok", { id: "u1" }, 1); // 1s * 1000 - 100000 < 0 -> not cached
    expect(cache.size).toBe(0);
  });

  it("clears the whole map once it grows past maxSize (documented off-by-one)", () => {
    const t = 0;
    const cache = makeTokenCache({ now: () => t, ttlMs: 60_000, maxSize: 2 });
    cache.set("a", { id: "a" });
    cache.set("b", { id: "b" });
    expect(cache.size).toBe(2);
    cache.set("c", { id: "c" }); // size 2 is not > 2 -> still adds
    expect(cache.size).toBe(3);
    cache.set("d", { id: "d" }); // size 3 > 2 -> clear, then add
    expect(cache.size).toBe(1);
  });
});

describe("isRejectedTokenError", () => {
  class JWTExpired extends Error {}
  class JWTClaimValidationFailed extends Error {}
  class JWSSignatureVerificationFailed extends Error {}
  class JWSInvalid extends Error {}
  class JWTInvalid extends Error {}
  class NetworkGlitch extends Error {}

  const joseErrors = {
    JWTExpired,
    JWTClaimValidationFailed,
    JWSSignatureVerificationFailed,
    JWSInvalid,
    JWTInvalid,
  };

  it("flags every jose verdict error as a real rejection (401)", () => {
    for (const E of Object.values(joseErrors)) {
      expect(isRejectedTokenError(new E("x"), joseErrors)).toBe(true);
    }
  });

  it("does not flag an inconclusive error (that path must fall back, not 401)", () => {
    expect(isRejectedTokenError(new NetworkGlitch("timeout"), joseErrors)).toBe(false);
  });
});
