import { describe, it, expect } from "vitest";
import { buildPrintSettings, formatPageRanges } from "../electron/print/settings.js";

describe("formatPageRanges", () => {
  it("converts 0-based Electron ranges to 1-based SumatraPDF syntax", () => {
    expect(formatPageRanges([{ from: 0, to: 2 }, { from: 4, to: 4 }])).toBe("1-3,5");
  });

  it("returns an empty string when there is nothing to restrict", () => {
    expect(formatPageRanges([])).toBe("");
    expect(formatPageRanges(undefined)).toBe("");
  });

  it("drops malformed ranges instead of emitting garbage tokens", () => {
    expect(formatPageRanges([{ from: -1, to: 3 }, { from: 2, to: 1 }])).toBe("3");
  });
});

describe("buildPrintSettings", () => {
  it("emits the shop defaults for an empty option set", () => {
    expect(buildPrintSettings({})).toBe("color,simplex,shrink");
  });

  it("maps duplex, colour, copies and paper", () => {
    const s = buildPrintSettings({
      duplexMode: "longEdge",
      color: false,
      copies: 3,
      pageSize: "A4",
    });
    expect(s).toBe("3x,monochrome,duplexlong,paper=a4,shrink");
  });

  it("omits the copies token for a single copy", () => {
    expect(buildPrintSettings({ copies: 1 })).not.toMatch(/\d+x/);
    expect(buildPrintSettings({ copies: 4 })).toMatch(/\b4x\b/);
  });

  it("only asserts orientation when landscape was explicitly requested", () => {
    expect(buildPrintSettings({ landscape: false })).not.toContain("landscape");
    expect(buildPrintSettings({ landscape: true })).toContain("landscape");
  });

  it("ignores an unknown paper size rather than passing it through", () => {
    expect(buildPrintSettings({ pageSize: "default" })).not.toContain("paper=");
  });

  it("puts page ranges first", () => {
    expect(buildPrintSettings({ pageRanges: [{ from: 1, to: 3 }] })).toMatch(/^2-4,/);
  });
});
