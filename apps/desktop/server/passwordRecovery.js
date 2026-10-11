// Forgotten-password recovery for the single operator account.
//
// Two independent ways back in, both ending in a brand-new password:
//
//  1. Recovery code — a one-time code the operator generates while logged in
//     (Settings → Password, or right after the first-run wizard sets the
//     password) and keeps somewhere safe. Stored only as a scrypt hash, shown
//     in plaintext exactly once. Using it consumes it and issues a fresh one.
//
//  2. Email code — a 6-digit code mailed through the connected Gmail account
//     to that same account's own address. The destination is never taken from
//     the request, so a stranger at the counter can't redirect it. Codes live
//     15 minutes and die after 5 wrong guesses.
//
// Failed attempts at either feed the same per-IP lockout as the login form.
import { randomBytes, randomInt } from "crypto";
import { getGmailAccount, getInternalState, setInternalState } from "../db.js";
import { hashPassword, verifyHash } from "./passwords.js";

const RECOVERY_KEY = "adminRecoveryCode";
const EMAIL_CODE_KEY = "adminResetEmailCode";

const EMAIL_CODE_TTL_MS = 15 * 60_000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_COOLDOWN_MS = 60_000;

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

/** "ahmed@gmail.com" -> "ah***@gmail.com" — enough to recognise, not to harvest. */
export function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "";
  return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
}

function connectedRecoveryEmail() {
  const account = getGmailAccount();
  if (!account || !account.is_active || !account.gmail_email || !account.refresh_token) return null;
  return account.gmail_email;
}

/** What the login screen may offer. Never reveals the full address. */
export function recoveryOptions() {
  const email = connectedRecoveryEmail();
  return {
    recoveryCode: recoveryCodeStatus().hasCode,
    email: email ? maskEmail(email) : null,
  };
}

/**
 * Mail a fresh 6-digit code to the connected Gmail account.
 * `sendEmail` is injected so tests don't need googleapis.
 * Returns { ok: true, sentTo } or { ok: false, status, error, retryMs? }.
 */
export async function sendEmailResetCode(sendEmail, { shopName = "" } = {}) {
  const email = connectedRecoveryEmail();
  if (!email) {
    return { ok: false, status: 400, error: "No Gmail account is connected to receive a reset code" };
  }
  const previous = getInternalState(EMAIL_CODE_KEY);
  const sinceLast = previous?.sentAt ? Date.now() - previous.sentAt : Infinity;
  if (sinceLast < EMAIL_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      status: 429,
      error: "A code was sent less than a minute ago. Check your inbox or wait a moment.",
      retryMs: EMAIL_RESEND_COOLDOWN_MS - sinceLast,
    };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const brand = shopName ? `${shopName} — Atba3li` : "Atba3li";
  await sendEmail({
    to: email,
    subject: `${brand}: password reset code ${code}`,
    text: [
      `Your Atba3li admin password reset code is: ${code}`,
      "",
      "It expires in 15 minutes. If you did not ask to reset the password, ignore this email — your password has not changed.",
      "",
      `رمز إعادة تعيين كلمة مرور لوحة تحكم Atba3li هو: ${code}`,
      "صالح لمدة 15 دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة المرور لم تتغير.",
    ].join("\n"),
  });

  setInternalState(EMAIL_CODE_KEY, {
    hash: hashPassword(code),
    sentAt: Date.now(),
    expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
    attempts: 0,
  });
  return { ok: true, sentTo: maskEmail(email) };
}

export function verifyEmailCode(code) {
  const stored = getInternalState(EMAIL_CODE_KEY);
  const clean = String(code || "").replace(/\D/g, "");
  if (!stored?.hash) return false;
  if (Date.now() > stored.expiresAt || stored.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    setInternalState(EMAIL_CODE_KEY, null);
    return false;
  }
  if (clean.length === 6 && verifyHash(clean, stored.hash)) return true;
  stored.attempts += 1;
  setInternalState(EMAIL_CODE_KEY, stored.attempts >= EMAIL_CODE_MAX_ATTEMPTS ? null : stored);
  return false;
}

/** A used email code is spent. */
export function consumeEmailCode() {
  setInternalState(EMAIL_CODE_KEY, null);
}
