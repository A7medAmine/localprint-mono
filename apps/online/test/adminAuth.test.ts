// Super-admin auth unit tests. Pure module (no env, no Supabase) so it loads
// without the server's startup checks.
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — plain .js module with no type declarations.
import * as auth from '../auth/adminAuth.js';

const {
  hashPassword, verifyPassword, safeEqual, readAdminCredentials, checkCredentials,
  createSession, getSession, destroySession, destroyAllSessions,
  isLockedOut, recordFailure, clearFailures, parseCookies, sessionCookie, clearedSessionCookie,
} = auth as any;

// scrypt at N=16384 is deliberately slow; the tests use cheap params where the
// cost is irrelevant to what is being asserted.
const CHEAP = { N: 1024, r: 8, p: 1, keylen: 32 };

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('correct horse battery', CHEAP);
    expect(stored.startsWith('scrypt:1024:8:1:')).toBe(true);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
    expect(verifyPassword('correct horse batterz', stored)).toBe(false);
  });

  it('salts — the same password hashes differently each time', () => {
    expect(hashPassword('same', CHEAP)).not.toBe(hashPassword('same', CHEAP));
  });

  it('rejects malformed or empty stored values', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', 'bcrypt:whatever')).toBe(false);
    expect(verifyPassword('x', 'scrypt:1024:8:1:zz:zz')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('credentials', () => {
  it('is unconfigured when neither hash nor plaintext is set', () => {
    const creds = readAdminCredentials({});
    expect(creds.configured).toBe(false);
    expect(checkCredentials('admin', 'anything', creds)).toBe(false);
  });

  it('defaults the username to "admin"', () => {
    expect(readAdminCredentials({ PLATFORM_ADMIN_PASSWORD: 'hunter2hunter2' }).username).toBe('admin');
  });

  it('accepts the hashed password and rejects a wrong username', () => {
    const creds = readAdminCredentials({
      PLATFORM_ADMIN_USERNAME: 'ahmed',
      PLATFORM_ADMIN_PASSWORD_HASH: hashPassword('s3cret-passphrase', CHEAP),
    });
    expect(checkCredentials('ahmed', 's3cret-passphrase', creds)).toBe(true);
    expect(checkCredentials('admin', 's3cret-passphrase', creds)).toBe(false);
    expect(checkCredentials('ahmed', 'nope', creds)).toBe(false);
  });

  it('falls back to the plaintext dev password when no hash is set', () => {
    const creds = readAdminCredentials({ PLATFORM_ADMIN_PASSWORD: 'devpassword' });
    expect(checkCredentials('admin', 'devpassword', creds)).toBe(true);
    expect(checkCredentials('admin', 'devpasswore', creds)).toBe(false);
  });
});

describe('sessions', () => {
  beforeEach(() => destroyAllSessions());

  it('round-trips a session and issues a distinct CSRF token', () => {
    const { sid, csrf } = createSession('admin');
    expect(sid).not.toBe(csrf);
    expect(getSession(sid)?.username).toBe('admin');
    expect(getSession(sid)?.csrf).toBe(csrf);
  });

  it('returns null for unknown or destroyed sessions', () => {
    const { sid } = createSession('admin');
    destroySession(sid);
    expect(getSession(sid)).toBe(null);
    expect(getSession('nope')).toBe(null);
    expect(getSession(undefined)).toBe(null);
  });
});

describe('login lockout', () => {
  beforeEach(() => clearFailures('victim'));

  it('locks after 5 failures and clears on success', () => {
    for (let i = 0; i < 4; i++) recordFailure('victim');
    expect(isLockedOut('victim')).toBe(false);
    recordFailure('victim');
    expect(isLockedOut('victim')).toBe(true);
    clearFailures('victim');
    expect(isLockedOut('victim')).toBe(false);
  });
});

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; lp_admin_session=abc; b=2').lp_admin_session).toBe('abc');
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });

  it('sets HttpOnly + SameSite, and Secure only outside dev', () => {
    const prod = sessionCookie('sid123', { secure: true });
    expect(prod).toContain('HttpOnly');
    expect(prod).toContain('SameSite=Strict');
    expect(prod).toContain('Secure');
    expect(sessionCookie('sid123', { secure: false })).not.toContain('Secure');
  });

  it('expires the cookie on logout', () => {
    expect(clearedSessionCookie({ secure: true })).toContain('Max-Age=0');
  });
});
