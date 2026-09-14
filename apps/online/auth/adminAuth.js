// Platform super-admin authentication.
//
// Two ways in, on purpose:
//   1. Username + password  → a signed-in browser session (httpOnly cookie).
//      This is what the /platform-admin console uses.
//   2. `Authorization: Bearer <PLATFORM_ADMIN_TOKEN>` → for scripts and curl.
//      Kept so existing provisioning tooling does not break.
//
// Sessions live in memory: a process restart logs the admin out, which is fine
// for a single-node deployment and avoids a session table. If this ever runs on
// more than one node, move `sessions` into Postgres/Redis — nothing else here
// has to change.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";

export const SESSION_COOKIE = "lp_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// ── Password hashing ──
// Stored form: scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>
export function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  let expected;
  try {
    expected = Buffer.from(hashHex, "hex");
    // Buffer.from ignores invalid hex, so a junk field can decode to a 0-byte
    // buffer — and timingSafeEqual on two empty buffers is `true`, which would
    // let ANY password through. Require a real key length.
    if (expected.length < 16) return false;
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Constant-time compare for the plaintext dev fallback and the bearer token.
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Hash first: timingSafeEqual throws on length mismatch, and the length
  // itself would otherwise leak through the early return.
  const hA = createHash("sha256").update(bufA).digest();
  const hB = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(hA, hB);
}

// ── Credential config ──
export function readAdminCredentials(env = process.env) {
  const username = (env.PLATFORM_ADMIN_USERNAME || "admin").trim();
  const passwordHash = (env.PLATFORM_ADMIN_PASSWORD_HASH || "").trim();
  const plainPassword = (env.PLATFORM_ADMIN_PASSWORD || "").trim();
  return {
    username,
    passwordHash,
    plainPassword,
    configured: Boolean(passwordHash || plainPassword),
  };
}

export function checkCredentials(username, password, creds) {
  if (!creds.configured) return false;
  // Compare the username in constant time too — it is a secret-ish value here.
  if (!safeEqual(username, creds.username)) return false;
  if (creds.passwordHash) return verifyPassword(password, creds.passwordHash);
  return safeEqual(password, creds.plainPassword);
}

// ── Session store ──
const sessions = new Map(); // sid -> { username, csrf, expiresAt }

function prune() {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt <= now) sessions.delete(sid);
}

export function createSession(username) {
  prune();
  const sid = randomBytes(32).toString("hex");
  const csrf = randomBytes(24).toString("hex");
  sessions.set(sid, { username, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
  return { sid, csrf, expiresAt: Date.now() + SESSION_TTL_MS, maxAgeMs: SESSION_TTL_MS };
}

export function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

export function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

export function destroyAllSessions() {
  sessions.clear();
}

// ── Login throttling ──
// The rate limiter is per-IP; this adds a per-account lockout so a distributed
// guess against one username still stalls.
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MAX_FAILS = 5;
const failures = new Map(); // username -> timestamps[]

export function isLockedOut(username) {
  const now = Date.now();
  const fresh = (failures.get(username) || []).filter((t) => now - t < LOCKOUT_WINDOW_MS);
  if (fresh.length === 0) failures.delete(username);
  else failures.set(username, fresh);
  return fresh.length >= LOCKOUT_MAX_FAILS;
}

export function recordFailure(username) {
  const fresh = (failures.get(username) || []).filter((t) => Date.now() - t < LOCKOUT_WINDOW_MS);
  fresh.push(Date.now());
  failures.set(username, fresh);
}

export function clearFailures(username) {
  failures.delete(username);
}

// ── Cookie helpers (Express 5 ships no cookie parser) ──
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(sid, { secure, maxAgeMs = SESSION_TTL_MS }) {
  const attrs = [
    `${SESSION_COOKIE}=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie({ secure }) {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
