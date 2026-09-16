import { describe, it, expect } from "vitest";
import {
  normalizeSocialUrl,
  normalizeSocialLinks,
  activeSocialLinks,
  normalizeDescription,
  MAX_DESCRIPTION_LENGTH,
} from "@atba3li/shared/social";

describe("normalizeSocialUrl", () => {
  it("keeps a full link and upgrades it to https", () => {
    expect(normalizeSocialUrl("facebook", "http://facebook.com/myshop")).toBe(
      "https://facebook.com/myshop",
    );
    expect(normalizeSocialUrl("tiktok", "https://tiktok.com/@myshop")).toBe(
      "https://tiktok.com/@myshop",
    );
    expect(normalizeSocialUrl("whatsapp", "https://wa.me/213555001122")).toBe(
      "https://wa.me/213555001122",
    );
  });

  it("fills in a missing scheme", () => {
    expect(normalizeSocialUrl("website", "myshop.dz")).toBe("https://myshop.dz");
    expect(normalizeSocialUrl("instagram", "instagram.com/myshop")).toBe(
      "https://instagram.com/myshop",
    );
  });

  it("rejects a bare username — a link is the only accepted input", () => {
    expect(normalizeSocialUrl("instagram", "@myshop")).toBeNull();
    expect(normalizeSocialUrl("tiktok", "myshop")).toBeNull();
    expect(normalizeSocialUrl("whatsapp", "+213 555 00 11 22")).toBeNull();
  });

  it("drops anything that is not an http(s) link", () => {
    expect(normalizeSocialUrl("website", "javascript:alert(1)")).toBeNull();
    expect(normalizeSocialUrl("website", "data:text/html,<script>x</script>")).toBeNull();
    expect(normalizeSocialUrl("website", "file:///etc/passwd")).toBeNull();
  });

  it("drops empties, over-long values and unknown platforms", () => {
    expect(normalizeSocialUrl("instagram", "   ")).toBeNull();
    expect(normalizeSocialUrl("instagram", `https://instagram.com/${"a".repeat(400)}`)).toBeNull();
    expect(normalizeSocialUrl("myspace", "https://myspace.com/myshop")).toBeNull();
    expect(normalizeSocialUrl("instagram", 42)).toBeNull();
  });
});

describe("normalizeSocialLinks", () => {
  it("keeps only the known, resolvable platforms", () => {
    expect(
      normalizeSocialLinks({
        instagram: "https://instagram.com/myshop",
        tiktok: "@myshop",
        facebook: "",
        website: "javascript:alert(1)",
        myspace: "https://myspace.com/myshop",
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
