import { describe, it, expect } from "vitest";
import {
  normalizeSocialUrl,
  normalizeSocialLinks,
  activeSocialLinks,
  normalizeDescription,
  MAX_DESCRIPTION_LENGTH,
} from "@atba3li/shared/social";

describe("normalizeSocialUrl", () => {
  it("turns a handle into the platform's own URL", () => {
    expect(normalizeSocialUrl("instagram", "@myshop")).toBe("https://instagram.com/myshop");
    expect(normalizeSocialUrl("tiktok", "myshop")).toBe("https://tiktok.com/@myshop");
    expect(normalizeSocialUrl("telegram", "@myshop")).toBe("https://t.me/myshop");
  });

  it("keeps a full link and upgrades it to https", () => {
    expect(normalizeSocialUrl("facebook", "http://facebook.com/myshop")).toBe(
      "https://facebook.com/myshop",
    );
    expect(normalizeSocialUrl("website", "myshop.dz")).toBe("https://myshop.dz");
  });

  it("builds a wa.me link from a phone number", () => {
    expect(normalizeSocialUrl("whatsapp", "+213 555 00 11 22")).toBe("https://wa.me/213555001122");
  });

  it("drops anything that is not an http(s) link", () => {
    expect(normalizeSocialUrl("website", "javascript:alert(1)")).toBeNull();
    expect(normalizeSocialUrl("website", "data:text/html,<script>x</script>")).toBeNull();
    expect(normalizeSocialUrl("website", "file:///etc/passwd")).toBeNull();
  });

  it("drops empties, over-long values and unknown platforms", () => {
    expect(normalizeSocialUrl("instagram", "   ")).toBeNull();
    expect(normalizeSocialUrl("instagram", "a".repeat(400))).toBeNull();
    expect(normalizeSocialUrl("myspace", "myshop")).toBeNull();
    expect(normalizeSocialUrl("instagram", 42)).toBeNull();
  });
});

describe("normalizeSocialLinks", () => {
  it("keeps only the known, resolvable platforms", () => {
    expect(
      normalizeSocialLinks({
        instagram: "@myshop",
        facebook: "",
        website: "javascript:alert(1)",
        myspace: "myshop",
      }),
    ).toEqual({ instagram: "https://instagram.com/myshop" });
  });

  it("returns an empty bag for junk input", () => {
    expect(normalizeSocialLinks(null)).toEqual({});
    expect(normalizeSocialLinks(["instagram"])).toEqual({});
    expect(normalizeSocialLinks("instagram")).toEqual({});
  });
});

describe("activeSocialLinks", () => {
  it("lists the filled platforms in display order", () => {
    const links = activeSocialLinks({
      website: "https://myshop.dz",
      instagram: "https://instagram.com/myshop",
    });
    expect(links.map((l) => l.platform.id)).toEqual(["instagram", "website"]);
  });

  it("is empty when nothing is set", () => {
    expect(activeSocialLinks(null)).toEqual([]);
    expect(activeSocialLinks({})).toEqual([]);
  });
});

describe("normalizeDescription", () => {
  it("trims and caps", () => {
    expect(normalizeDescription("  hello  ")).toBe("hello");
    expect(normalizeDescription("x".repeat(600))).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(normalizeDescription(undefined)).toBe("");
  });
});
