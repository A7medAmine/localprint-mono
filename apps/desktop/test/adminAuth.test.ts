import { describe, it, expect, beforeEach, vi } from "vitest";

// The auth module persists tokens through db.js, which loads a native
// better-sqlite3 binding built for Electron. The behaviour under test is the
// token lifecycle, so the store is a plain in-memory map here.
const state = new Map<string, unknown>();
vi.mock("../db.js", () => ({
  default: {},
  getInternalState: (key: string) => state.get(key),
  setInternalState: (key: string, value: unknown) => state.set(key, value),
}));

const {
  generateToken,
  isValidAdminToken,
  requireAdmin,
  revokeToken,
  revokeOtherTokens,
  loginGuard,
  recordLoginFailure,
  clearLoginFailures,
  setMustChangePassword,
} = await import("../server/adminAuth.js");

type Res = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (code: number) => Res;
  json: (body: unknown) => Res;
  set: (key: string, value: string) => Res;
};

function makeRes(): Res {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    set(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
  };
  return res;
}

const reqWith = (token?: string, path = "/api/jobs", ip = "1.2.3.4") => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
  path,
  ip,
  socket: {},
});

beforeEach(() => {
  setMustChangePassword(false);
});

describe("admin tokens", () => {
  it("accepts a freshly minted token and rejects anything else", () => {
    const token = generateToken();
    expect(isValidAdminToken(reqWith(token))).toBe(true);
    expect(isValidAdminToken(reqWith("not-a-token"))).toBe(false);
    expect(isValidAdminToken(reqWith())).toBe(false);
  });

  it("rejects an Authorization header that is not a Bearer token", () => {
    const token = generateToken();
    expect(isValidAdminToken({ headers: { authorization: token }, path: "/", socket: {} })).toBe(false);
  });

  it("stops accepting a revoked token", () => {
    const token = generateToken();
    revokeToken(token);
    expect(isValidAdminToken(reqWith(token))).toBe(false);
  });

  it("logout-all keeps the caller's token and drops the rest", () => {
    const keep = generateToken();
    const other = generateToken();
    revokeOtherTokens(keep);
    expect(isValidAdminToken(reqWith(keep))).toBe(true);
    expect(isValidAdminToken(reqWith(other))).toBe(false);
  });

  it("persists tokens so a restart does not log the operator out", () => {
    generateToken();
    expect(Array.isArray(state.get("_admin_tokens"))).toBe(true);
  });
});

describe("requireAdmin", () => {
  it("401s without a token", () => {
    const res = makeRes();
    const next = vi.fn();
    requireAdmin(reqWith(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a valid token through", () => {
    const token = generateToken();
    const res = makeRes();
    const next = vi.fn();
    const req = reqWith(token);
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as { adminToken?: string }).adminToken).toBe(token);
  });

  it("blocks everything but password change and logout while the password is the default", () => {
    const token = generateToken();
    setMustChangePassword(true);

    const blocked = makeRes();
    const blockedNext = vi.fn();
    requireAdmin(reqWith(token, "/api/jobs"), blocked, blockedNext);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toMatchObject({ mustChangePassword: true });
    expect(blockedNext).not.toHaveBeenCalled();

    for (const path of ["/api/settings/password", "/api/auth/logout"]) {
      const res = makeRes();
      const next = vi.fn();
      requireAdmin(reqWith(token, path), res, next);
      expect(next).toHaveBeenCalled();
    }
  });
});

describe("login lockout", () => {
  it("lets attempts through until the fifth failure, then locks the IP", () => {
    const ip = "10.0.0.1";
    const pass = () => {
      const res = makeRes();
      const next = vi.fn();
      loginGuard(reqWith(undefined, "/api/auth/verify", ip), res, next);
      return { res, next };
    };

    for (let i = 0; i < 4; i++) recordLoginFailure(reqWith(undefined, "/", ip));
    expect(pass().next).toHaveBeenCalled();

    recordLoginFailure(reqWith(undefined, "/", ip));
    const locked = pass();
    expect(locked.res.statusCode).toBe(429);
    expect(locked.res.headers["Retry-After"]).toBeDefined();
    expect(locked.next).not.toHaveBeenCalled();
  });

  it("a successful login clears the count", () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 6; i++) recordLoginFailure(reqWith(undefined, "/", ip));
    clearLoginFailures(reqWith(undefined, "/", ip));

    const res = makeRes();
    const next = vi.fn();
    loginGuard(reqWith(undefined, "/api/auth/verify", ip), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("locks one IP without affecting another", () => {
    for (let i = 0; i < 6; i++) recordLoginFailure(reqWith(undefined, "/", "10.0.0.3"));
    const res = makeRes();
    const next = vi.fn();
    loginGuard(reqWith(undefined, "/api/auth/verify", "10.0.0.4"), res, next);
    expect(next).toHaveBeenCalled();
  });
});
