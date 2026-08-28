/**
 * Pure admin-token expiry/prune logic, extracted from server.js so the TTL
 * rules are importable/testable without the DB or the Express server. Phase 4.2
 * folds this into the shared auth helpers. Keep it dependency-free.
 *
 * A token entry is `{ token, createdAt, lastUsedAt }` (epoch ms). It dies once
 * it has been idle past `idleMs` OR is older than `absMs`, whichever first.
 */

export function isTokenExpired(meta, now, idleMs, absMs) {
  return now - meta.lastUsedAt > idleMs || now - meta.createdAt > absMs;
}

/**
 * Delete every expired entry from `map` in place. Returns `{ changed }` so the
 * caller can decide whether to persist. Mirrors server.js pruneTokens().
 */
export function pruneTokenMap(map, now, idleMs, absMs) {
  let changed = false;
  for (const [token, meta] of map) {
    if (isTokenExpired(meta, now, idleMs, absMs)) {
      map.delete(token);
      changed = true;
    }
  }
  return { changed };
}
