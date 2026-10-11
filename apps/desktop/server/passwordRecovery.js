// Forgotten-password recovery for the single operator account.
//
// The way back in is a recovery code: a one-time key handed to the operator
// right after the first-run wizard sets the password (or on the first login
// of an install that has none yet, or from Settings → Password). They
// download it and keep it safe. Stored only as a scrypt hash, shown in
// plaintext exactly once. Using it consumes it and issues a fresh one.
//
// Failed attempts feed the same per-IP lockout as the login form.
import { randomBytes } from "crypto";
import { getInternalState, setInternalState } from "../db.js";
import { hashPassword, verifyHash } from "./passwords.js";

const RECOVERY_KEY = "adminRecoveryCode";

// No 0/O, 1/I/L — the code gets read off paper and typed back by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Upper-case and strip everything but the alphabet, so "abcd-efgh ..." works. */
const normalizeRecoveryCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

function randomRecoveryCode() {
  const bytes = randomBytes(16);
  let raw = "";
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return raw.match(/.{4}/g).join("-");
}

/** Create (or replace) the recovery code. Returns the plaintext — show it once. */
export function generateRecoveryCode() {
  const code = randomRecoveryCode();
  setInternalState(RECOVERY_KEY, {
    hash: hashPassword(normalizeRecoveryCode(code)),
    createdAt: new Date().toISOString(),
  });
  return code;
}

export function recoveryCodeStatus() {
  const stored = getInternalState(RECOVERY_KEY);
  return stored?.hash ? { hasCode: true, createdAt: stored.createdAt || null } : { hasCode: false, createdAt: null };
}

export function verifyRecoveryCode(code) {
  const stored = getInternalState(RECOVERY_KEY);
  const normalized = normalizeRecoveryCode(code);
  if (!stored?.hash || normalized.length !== 16) return false;
  return verifyHash(normalized, stored.hash);
}

/** What the login screen may offer. */
export function recoveryOptions() {
  return { recoveryCode: recoveryCodeStatus().hasCode };
}
