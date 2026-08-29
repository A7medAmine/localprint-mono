import { describe, it, expect } from "vitest";
import {
  layoutBatch,
  estimateDpi,
  computePrintableRect,
  mmToPt,
  MM_TO_PT,
  PhotoItem,
  BatchOptions,
} from "../lib/photoLayout";

const A4 = { widthPt: 595.28, heightPt: 841.89 };

function makeOptions(overrides: Partial<BatchOptions> = {}): BatchOptions {
  return {
    page: A4,
    margins: { topMm: 3, rightMm: 3, bottomMm: 3, leftMm: 3 },
    fit: "cover",
    autoRotate: true,
    background: "#ffffff",
    copies: 1,
    ...overrides,
  };
}

function item(id: string, w: number, h: number, overrides: Partial<PhotoItem> = {}): PhotoItem {
  return { id, naturalWidth: w, naturalHeight: h, ...overrides };
}

const approx = (a: number, b: number, eps = 0.5) => Math.abs(a - b) < eps;

describe("layoutBatch — auto-rotate", () => {
  it("landscape photo on A4 → page rotated to landscape, photo fills printable width", () => {
    const [page] = layoutBatch([item("p1", 2000, 1000)], makeOptions());
    expect(page.pageWidthPt).toBeGreaterThan(page.pageHeightPt); // landscape sheet
    expect(approx(page.draw.w, page.draw.clipRect!.w)).toBe(true); // fills width
    expect(approx(page.draw.h, page.draw.clipRect!.h)).toBe(true); // and height (cover)
  });

  it("portrait photo on A4 → page stays portrait", () => {
    const [page] = layoutBatch([item("p1", 1000, 2000)], makeOptions());
    expect(page.pageWidthPt).toBeLessThan(page.pageHeightPt);
  });

  it("near-square photo on A4 → page stays portrait (rotation doesn't help)", () => {
    const [page] = layoutBatch([item("p1", 1000, 999)], makeOptions());
    expect(page.pageWidthPt).toBeLessThan(page.pageHeightPt);
  });
});

describe("layoutBatch — cover vs contain", () => {
  it("cover crops: rendered rect equals printable, crop centered with overflow hidden", () => {
    const [page] = layoutBatch(
      [item("p1", 1000, 2000)],
      makeOptions({ fit: "cover", autoRotate: false }),
    );
    const clip = page.draw.clipRect!;
    expect(approx(page.draw.w, clip.w)).toBe(true);
    expect(approx(page.draw.h, clip.h)).toBe(true);
    const crop = page.draw.sourceCropRect!;
    expect(crop).not.toBeNull();
    // Full width visible; vertical overflow cropped, centered.
    expect(approx(crop.sw, 1000, 1)).toBe(true);
    expect(crop.sh).toBeLessThan(2000);
    expect(approx(crop.sx + crop.sw / 2, 500, 1)).toBe(true);
    expect(approx(crop.sy + crop.sh / 2, 1000, 1)).toBe(true);
  });

  it("contain letterboxes: rendered rect ≤ printable, centered, no crop", () => {
    const [page] = layoutBatch(
      [item("p1", 2000, 1000)],
      makeOptions({ fit: "contain", autoRotate: false }),
    );
    const clip = page.draw.clipRect!;
    expect(page.draw.sourceCropRect).toBeNull();
    expect(page.draw.w).toBeLessThanOrEqual(clip.w + 0.5);
    expect(page.draw.h).toBeLessThanOrEqual(clip.h + 0.5);
    // Letterboxed horizontally on a portrait sheet → fills printable width,
    // centered vertically between the leftover strips.
    expect(approx(page.draw.w, clip.w, 1)).toBe(true);
    expect(approx(page.draw.y - clip.y, clip.h - page.draw.h - (page.draw.y - clip.y), 1)).toBe(true);
    expect(page.draw.background).toBe("#ffffff");
  });
});

describe("computePrintableRect — margins", () => {
  it("converts mm to pt (3mm ≈ 8.5pt)", () => {
    expect(mmToPt(3)).toBeCloseTo(8.5039, 2);
    expect(MM_TO_PT).toBeCloseTo(2.83465, 4);
  });

  it("3mm margins inset the printable rect on every side", () => {
    const r = computePrintableRect(A4.widthPt, A4.heightPt, { topMm: 3, rightMm: 3, bottomMm: 3, leftMm: 3 });
    expect(approx(r.x, mmToPt(3))).toBe(true);
    expect(approx(r.w, A4.widthPt - 2 * mmToPt(3))).toBe(true);
    expect(approx(r.h, A4.heightPt - 2 * mmToPt(3))).toBe(true);
  });

  it("borderless (0mm) → printable rect == page", () => {
    const r = computePrintableRect(A4.widthPt, A4.heightPt, { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 });
    expect(r).toEqual({ x: 0, y: 0, w: A4.widthPt, h: A4.heightPt });
  });

  it("margins larger than the page clamp to a 2mm printable strip", () => {
    const r = computePrintableRect(A4.widthPt, A4.heightPt, { topMm: 300, rightMm: 300, bottomMm: 300, leftMm: 300 });
    expect(r.w).toBeGreaterThanOrEqual(mmToPt(2) - 0.5);
    expect(r.h).toBeGreaterThanOrEqual(mmToPt(2) - 0.5);
  });
});

describe("layoutBatch — manual rotation composes with auto-rotate", () => {
  it("landscape photo with a 90° override becomes portrait → page stays portrait", () => {
    const [auto] = layoutBatch([item("p1", 2000, 1000)], makeOptions());
    expect(auto.pageWidthPt).toBeGreaterThan(auto.pageHeightPt); // landscape

    const [manual] = layoutBatch(
      [item("p1", 2000, 1000, { rotateQuarterTurns: 1 })],
      makeOptions(),
    );
    expect(manual.pageWidthPt).toBeLessThan(manual.pageHeightPt); // portrait
    expect(manual.draw.rotationDeg).toBe(90);
  });

  it("rotationDeg reflects only the manual turns", () => {
    const [p] = layoutBatch([item("p1", 1000, 1000, { rotateQuarterTurns: 3 })], makeOptions({ autoRotate: false }));
    expect(p.draw.rotationDeg).toBe(270);
  });
});

describe("estimateDpi", () => {
  it("1000px photo on a 100mm-wide printable area ≈ 254 DPI", () => {
    const page = { widthPt: 283.46, heightPt: 500 }; // 100mm wide page
    const [laid] = layoutBatch(
      [item("p1", 1000, 1000)],
      makeOptions({ page, margins: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 }, fit: "contain", autoRotate: false }),
    );
    expect(estimateDpi(item("p1", 1000, 1000), laid)).toBeCloseTo(254, 0);
  });

  it("cover crop uses visible (cropped) width for the DPI estimate", () => {
    const [laid] = layoutBatch(
      [item("p1", 2000, 2000)],
      makeOptions({ fit: "cover", autoRotate: false }),
    );
    const dpi = estimateDpi(item("p1", 2000, 2000), laid);
    expect(dpi).toBeGreaterThan(100);
    expect(dpi).toBeLessThan(Infinity);
  });
});
