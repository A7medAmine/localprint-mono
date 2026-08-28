// Short-lived memo for verified Supabase user tokens, extracted from db.js so
// its expiry math can be unit-tested with an injectable clock. Behavior is
// identical to the inline cache it replaced: a per-token TTL that never
// outlives the token's own `exp`, and a crude size cap that clears the whole
// map once it grows past `maxSize`.
export function makeTokenCache({ now = () => Date.now(), ttlMs = 60_000, maxSize = 1000 } = {}) {
  const map = new Map();
  return {
    get(token) {
      const hit = map.get(token);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        map.delete(token);
        return undefined;
      }
      return hit.user;
    },
    set(token, user, claimExpSeconds) {
      // Never outlive the token itself: clamp the TTL to the time left on `exp`.
      const ttl = claimExpSeconds
        ? Math.min(ttlMs, claimExpSeconds * 1000 - now())
        : ttlMs;
      if (ttl <= 0) return;
      if (map.size > maxSize) map.clear();
      map.set(token, { user, expiresAt: now() + ttl });
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

// True when jose successfully evaluated a token and rejected it (expired, bad
// signature, wrong audience, malformed). Those are real 401s; anything else is
// an inconclusive verdict (JWKS unreachable, legacy HS256) that must fall back
// to the remote check. `joseErrors` is injected so this stays import-free and
// testable with stand-in error classes.
export function isRejectedTokenError(err, joseErrors) {
  return (
    err instanceof joseErrors.JWTExpired ||
    err instanceof joseErrors.JWTClaimValidationFailed ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWTInvalid
  );
}
