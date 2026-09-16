import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// db.js loads a native better-sqlite3 binding built for Electron, so the tests
// drive the routes against an in-memory stand-in for the key/value state they
// actually touch.
const state = new Map<string, unknown>();
vi.mock("../db.js", () => ({
  default: {},
  getInternalState: (key: string) => state.get(key),
  setInternalState: (key: string, value: unknown) => state.set(key, value),
}));

const { registerAuthRoutes } = await import("../server/routes/auth.js");
const { setMustChangePassword, refreshMustChangePassword } = await import("../server/adminAuth.js");
const { hashPassword } = await import("../server/passwords.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  return app;
}

beforeEach(() => {
  state.clear();
  setMustChangePassword(false);
});

describe("first-run bootstrap", () => {
  it("reports a fresh install and issues a token without a password", async () => {
    const app = makeApp();

    const status = await request(app).get("/api/auth/status");
    expect(status.body).toEqual({ freshInstall: true });

    const res = await request(app).post("/api/auth/bootstrap");
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);

    // The token may only change the password — everything else stays blocked.
    const blocked = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${res.body.token}`);
    expect(blocked.status).toBe(403);

    const change = await request(app)
      .post("/api/settings/password")
      .set("Authorization", `Bearer ${res.body.token}`)
      .send({ currentPassword: "admin123", newPassword: "a-good-password" });
    expect(change.status).toBe(200);
  });

  it("refuses once a password has been set", async () => {
    state.set("adminPassword", hashPassword("correct horse battery"));
    refreshMustChangePassword();
    const app = makeApp();

    const status = await request(app).get("/api/auth/status");
    expect(status.body).toEqual({ freshInstall: false });

    const res = await request(app).post("/api/auth/bootstrap");
    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });
});

describe("POST /api/auth/verify", () => {
  it("issues a token for the default password on a fresh install", async () => {
    const res = await request(makeApp()).post("/api/auth/verify").send({ password: "admin123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    // A fresh install is still on the factory password, so the UI must be told.
    expect(res.body.mustChangePassword).toBe(true);
  });

  it("rejects a wrong password without issuing a token", async () => {
    // A failed login answers 200 with success:false — the client reads the flag,
    // and the status stays out of the browser's auth-challenge path.
    const res = await request(makeApp()).post("/api/auth/verify").send({ password: "nope" });
    expect(res.body).toEqual({ success: false });
    expect(res.body.token).toBeUndefined();
  });

  it("accepts the stored hash once the password has been changed", async () => {
    state.set("adminPassword", hashPassword("correct horse battery"));
    refreshMustChangePassword();
    const app = makeApp();

    const ok = await request(app).post("/api/auth/verify").send({ password: "correct horse battery" });
    expect(ok.status).toBe(200);
    expect(ok.body.mustChangePassword).toBe(false);

    const bad = await request(app).post("/api/auth/verify").send({ password: "admin123" });
    expect(bad.body).toEqual({ success: false });
  });
});

describe("POST /api/settings/password", () => {
  async function loginToken(app: express.Express, password = "admin123") {
    const res = await request(app).post("/api/auth/verify").send({ password });
    return res.body.token as string;
  }

  it("changes the password, clears the must-change flag and revokes other sessions", async () => {
    const app = makeApp();
    const stale = await loginToken(app);
    const token = await loginToken(app);

    const res = await request(app)
      .post("/api/settings/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "admin123", newPassword: "a-good-password" });

    expect(res.status).toBe(200);
    expect(state.get("adminPassword")).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

    // The session that made the change survives; the other one is gone.
    const still = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${token}`);
    expect(still.status).toBe(200);

    const dead = await request(app)
      .post("/api/settings/password")
      .set("Authorization", `Bearer ${stale}`)
      .send({ currentPassword: "a-good-password", newPassword: "another-password" });
    expect(dead.status).toBe(401);
  });

  it("refuses a password that fails the policy", async () => {
    const app = makeApp();
    const token = await loginToken(app);
    for (const newPassword of ["short", "12345678", "admin123"]) {
      const res = await request(app)
        .post("/api/settings/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: "admin123", newPassword });
      expect(res.status).toBe(400);
    }
    expect(state.get("adminPassword")).toBeUndefined();
  });

  it("refuses when the current password is wrong", async () => {
    const app = makeApp();
    const token = await loginToken(app);
    const res = await request(app)
      .post("/api/settings/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrong", newPassword: "a-good-password" });
    expect(res.status).toBe(401);
    expect(state.get("adminPassword")).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await request(makeApp())
      .post("/api/settings/password")
      .send({ currentPassword: "admin123", newPassword: "a-good-password" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the token it was called with", async () => {
    const app = makeApp();
    const login = await request(app).post("/api/auth/verify").send({ password: "admin123" });
    const token = login.body.token;

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`).expect(200);

    const after = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});
