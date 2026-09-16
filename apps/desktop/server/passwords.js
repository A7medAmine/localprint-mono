// Admin credential: hashing, policy, and the "still the factory default?" check.
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getInternalState } from "../db.js";

const SALT_LEN = 16;
const KEY_LEN = 64;

export const DEFAULT_PASSWORD = "admin123";

export function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN);
  return salt.toString("hex") + ":" + key.toString("hex");
}

export function verifyHash(password, stored) {
  if (!stored || !stored.includes(":")) {
    return false;
  }
  const [saltHex, keyHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  const derivedKey = scryptSync(password, salt, KEY_LEN);
  if (key.length !== derivedKey.length) return false;
  return timingSafeEqual(key, derivedKey);
}

export function passwordPolicyError(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (/^\d+$/.test(pw)) return "Password cannot be all digits";
  if (pw === DEFAULT_PASSWORD) return "Choose a password other than the default";
  return null;
}

// Does `password` match the stored credential? Handles the legacy plaintext
// default and upgrades it to a hash on first successful login.
export function checkAdminPassword(password) {
  const stored = getInternalState("adminPassword");
  if (!stored) {
    // Fresh install — the implicit credential is the default password.
    return password === DEFAULT_PASSWORD;
  }
  if (!stored.includes(":")) {
    return password === stored;
  }
  return verifyHash(password, stored);
}

// Is the current credential still the factory default?
export function isDefaultPassword() {
  const stored = getInternalState("adminPassword");
  if (!stored) return true;
  if (!stored.includes(":")) return stored === DEFAULT_PASSWORD;
  return verifyHash(DEFAULT_PASSWORD, stored);
}
