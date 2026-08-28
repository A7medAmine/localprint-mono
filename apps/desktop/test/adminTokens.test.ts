import { describe, it, expect } from "vitest";
import { isTokenExpired, pruneTokenMap } from "../utils/adminTokens.js";

// Contract for the admin-token TTL. now=0 baseline; idle=14d, abs=30d in ms.
const DAY = 86_400_000;
const IDLE = 14 * DAY;
const ABS = 30 * DAY;

function meta(createdAgo: number, idleAgo: number, now: number) {
  return { token: "t", createdAt: now - createdAgo, lastUsedAt: now - idleAgo };
}

describe("isTokenExpired", () => {
  const now = 100 * DAY;
  it("fresh token is valid", () => {
    expect(isTokenExpired(meta(0, 0, now), now, IDLE, ABS)).toBe(false);
  });
  it("valid just under both limits", () => {
    expect(isTokenExpired(meta(29 * DAY, 13 * DAY, now), now, IDLE, ABS)).toBe(false);
  });
  it("expires when idle past idleMs", () => {
    expect(isTokenExpired(meta(15 * DAY, 15 * DAY, now), now, IDLE, ABS)).toBe(true);
  });
  it("expires when older than absMs even if recently used", () => {
    expect(isTokenExpired(meta(31 * DAY, 0, now), now, IDLE, ABS)).toBe(true);
  });
});

describe("pruneTokenMap", () => {
  it("removes only expired entries and reports changed", () => {
    const now = 100 * DAY;
    const map = new Map<string, { token: string; createdAt: number; lastUsedAt: number }>([
      ["fresh", { token: "fresh", createdAt: now, lastUsedAt: now }],
      ["idle", { token: "idle", createdAt: now - 5 * DAY, lastUsedAt: now - 20 * DAY }],
      ["old", { token: "old", createdAt: now - 40 * DAY, lastUsedAt: now }],
    ]);
    const { changed } = pruneTokenMap(map, now, IDLE, ABS);
    expect(changed).toBe(true);
    expect([...map.keys()]).toEqual(["fresh"]);
  });

  it("no expired entries → changed=false, map intact", () => {
    const now = 100 * DAY;
    const map = new Map([["fresh", { token: "fresh", createdAt: now, lastUsedAt: now }]]);
    const { changed } = pruneTokenMap(map, now, IDLE, ABS);
    expect(changed).toBe(false);
    expect(map.size).toBe(1);
  });
});
