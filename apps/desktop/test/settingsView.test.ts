import { describe, it, expect } from "vitest";
import {
  parseCloudLink,
  pickPublicSettings,
  stripSecretSettings,
} from "../server/settingsView.js";

describe("parseCloudLink", () => {
  it("splits a storefront link into base URL and slug", () => {
    expect(parseCloudLink("https://cloud.example.com/s/acme")).toEqual({
      baseUrl: "https://cloud.example.com",
      slug: "acme",
    });
  });

  it("ignores anything after the slug", () => {
    expect(parseCloudLink("https://cloud.example.com/s/acme/upload?x=1")).toEqual({
      baseUrl: "https://cloud.example.com",
      slug: "acme",
    });
  });

  it("keeps a path prefix that sits before /s/", () => {
    expect(parseCloudLink("https://host.tld/print/s/acme")).toEqual({
      baseUrl: "https://host.tld/print",
      slug: "acme",
    });
  });

  it("accepts a bare root URL — the slug arrives on the first settings sync", () => {
    expect(parseCloudLink("cloud.example.com")).toEqual({
      baseUrl: "https://cloud.example.com",
      slug: "",
    });
  });

  it("decodes a percent-encoded slug", () => {
    expect(parseCloudLink("https://h.tld/s/a%20b").slug).toBe("a b");
  });

  it("returns empties for blank input", () => {
    expect(parseCloudLink("")).toEqual({ baseUrl: "", slug: "" });
    expect(parseCloudLink(null)).toEqual({ baseUrl: "", slug: "" });
  });

  it("falls back to the trimmed text when the URL cannot be parsed", () => {
    // "http://" parses to an origin-less URL; the trailing slashes are trimmed.
    expect(parseCloudLink("http://").baseUrl).toBe("http:");
  });
});

describe("settings exposure", () => {
  const settings: Record<string, unknown> = {
    shopName: "Acme Print",
    currency: "DZD",
    adminPassword: "hash",
    gmailTokens: { refresh_token: "secret" },
    autoDeductStock: true,
  };

  it("public view carries only allowlisted keys", () => {
    const view = pickPublicSettings(settings);
    expect(view).toEqual({ shopName: "Acme Print", currency: "DZD" });
    expect(view).not.toHaveProperty("adminPassword");
    expect(view).not.toHaveProperty("gmailTokens");
  });

  it("admin view keeps everything except the secrets", () => {
    const view = stripSecretSettings(settings) as Record<string, unknown>;
    expect(view).not.toHaveProperty("gmailTokens");
    expect(view.autoDeductStock).toBe(true);
    expect(view.shopName).toBe("Acme Print");
  });

  it("omits allowlisted keys that are not set", () => {
    expect(pickPublicSettings({ shopName: "X" })).toEqual({ shopName: "X" });
  });
});
