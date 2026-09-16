// Admin session tokens, the requireAdmin gate, and the per-IP login lockout.
//
// Tokens are persisted in the DB so a restart does not log the operator out.
// Each entry is { token, createdAt, lastUsedAt }: a token dies once it has been
// idle past TOKEN_IDLE_MS or once it is older than TOKEN_ABSOLUTE_MS, whichever
// comes first.
import { randomBytes } from "crypto";
import { getInternalState, setInternalState } from "../db.js";
import { pruneTokenMap } from "../utils/adminTokens.js";
import { isDefaultPassword } from "./passwords.js";

const TOKEN_IDLE_MS = Number(process.env.ADMIN_TOKEN_IDLE_DAYS || 14) * 86_400_000;
const TOKEN_ABSOLUTE_MS = Number(process.env.ADMIN_TOKEN_MAX_DAYS || 30) * 86_400_000;

function loadTokens() {
  try {
    const parsed = getInternalState("_admin_tokens");
    if (!parsed) return new Map();
    const map = new Map();
    if (Array.isArray(parsed)) {
      const now = Date.now();
      for (const entry of parsed) {
        if (typeof entry === "string") {
          // legacy: bare token string, no timestamps — treat as fresh once
          map.set(entry, { token: entry, createdAt: now, lastUsedAt: now });
        } else if (entry && entry.token) {
          map.set(entry.token, {
            token: entry.token,
            createdAt: entry.createdAt || now,
            lastUsedAt: entry.lastUsedAt || entry.createdAt || now,
          });
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export const adminTokens = loadTokens();

export function saveTokens(tokens = adminTokens) {
  setInternalState("_admin_tokens", [...tokens.values()]);
}

export function pruneTokens() {
  const { changed } = pruneTokenMap(adminTokens, Date.now(), TOKEN_IDLE_MS, TOKEN_ABSOLUTE_MS);
  if (changed) saveTokens(adminTokens);
}

export function generateToken() {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  adminTokens.set(token, { token, createdAt: now, lastUsedAt: now });
  saveTokens(adminTokens);
  return token;
}

/** Revoke every token except `keepToken` (logout-all, and on password change). */
export function revokeOtherTokens(keepToken) {
  for (const token of [...adminTokens.keys()]) {
    if (token !== keepToken) adminTokens.delete(token);
  }
  saveTokens(adminTokens);
}

export function revokeToken(token) {
  adminTokens.delete(token);
  saveTokens(adminTokens);
}

/** The token string if valid (bumping lastUsedAt), else null. */
export function validAdminToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  pruneTokens();
  const meta = adminTokens.get(token);
  if (!meta) return null;
  meta.lastUsedAt = Date.now();
  // Persist the touch lazily — a write per request is wasteful; the hourly
  // prune and login/logout writes are enough to survive a restart.
  return token;
}

export function isValidAdminToken(req) {
  return validAdminToken(req) !== null;
}

// True while the admin password is still the factory default.
let mustChangePassword = isDefaultPassword();

export const getMustChangePassword = () => mustChangePassword;

export const refreshMustChangePassword = () => {
  mustChangePassword = isDefaultPassword();
  return mustChangePassword;
};

export const setMustChangePassword = (value) => {
  mustChangePassword = value;
};

/** Middleware: require a valid admin token. */
export function requireAdmin(req, res, next) {
  const token = validAdminToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.adminToken = token;
  // While the password is still the default, the only things the operator may
  // do are change it or log out.
  if (mustChangePassword) {
    const allowed = ["/api/settings/password", "/api/auth/logout"];
    if (!allowed.includes(req.path)) {
      return res.status(403).json({ error: "Password change required", mustChangePassword: true });
    }
  }
  next();
}

// ── Login lockout (per-IP, counts FAILED /api/auth/verify attempts only) ──
// 5 fails -> locked 1 min, 10 fails -> locked 15 min. A success clears the count.
const loginFailMap = new Map(); // ip -> { count, lockedUntil }
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

export function loginGuard(req, res, next) {
  const rec = loginFailMap.get(clientIp(req));
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const retryMs = rec.lockedUntil - Date.now();
    res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    return res.status(429).json({ error: "Too many failed attempts. Try again later.", retryMs });
  }
  next();
}

export function recordLoginFailure(req) {
  const ip = clientIp(req);
  const rec = loginFailMap.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 10) rec.lockedUntil = Date.now() + 15 * 60_000;
  else if (rec.count >= 5) rec.lockedUntil = Date.now() + 60_000;
  loginFailMap.set(ip, rec);
  if (rec.lockedUntil > Date.now()) {
    console.warn(
      `🔒 Login lockout for ${ip} (${rec.count} failed attempts) until ${new Date(rec.lockedUntil).toISOString()}`,
    );
  }
}

export function clearLoginFailures(req) {
  loginFailMap.delete(clientIp(req));
}

/** Background timers the long-running server wants; tests skip these. */
export function startAuthMaintenance() {
  // Prune stale tokens hourly.
  const prune = setInterval(pruneTokens, 3_600_000);
  // Drop lockout records once they have fully expired.
  const lockouts = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of loginFailMap) {
      if ((!rec.lockedUntil || rec.lockedUntil < now) && now - (rec.lockedUntil || 0) > 3_600_000) {
        loginFailMap.delete(ip);
      }
    }
  }, 600_000);
  prune.unref?.();
  lockouts.unref?.();
  pruneTokens();
  return () => {
    clearInterval(prune);
    clearInterval(lockouts);
  };
}
