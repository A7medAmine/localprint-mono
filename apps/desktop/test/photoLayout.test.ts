import { describe, it, expect } from "vitest";
import {
  layoutGroups,
  resolvePlacementDraw,
  estimateDpi,
  computePrintableRect,
  mmToPt,
  MM_TO_PT,
  PhotoItem,
  BatchOptions,
  PageGroup,
  PlacementOverride,
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

// Lays out a single-item group and returns { page, draw } for convenience —
// mirrors the old single-photo-per-page test shape.
function layoutOne(it: PhotoItem, options: BatchOptions, override?: PlacementOverride) {
  const groups: PageGroup[] = [{ id: "g1", itemIds: [it.id] }];
  const overridesById = override ? { [it.id]: override } : {};
  const [page] = layoutGroups(groups, { [it.id]: it }, overridesById, options);
  const placement = page.placements[0];
  const draw = resolvePlacementDraw(it, placement, options.background);
  return { page, placement, draw };
}

describe("layoutGroups — auto-rotate (single-photo page)", () => {
  it("landscape photo on A4 → page rotated to landscape, photo fills printable width", () => {
    const { page, draw } = layoutOne(item("p1", 2000, 1000), makeOptions());
    expect(page.pageWidthPt).toBeGreaterThan(page.pageHeightPt); // landscape sheet
    expect(approx(draw.w, draw.clipRect.w)).toBe(true); // fills width
    expect(approx(draw.h, draw.clipRect.h)).toBe(true); // and height (cover)
  });

  it("portrait photo on A4 → page stays portrait", () => {
    const { page } = layoutOne(item("p1", 1000, 2000), makeOptions());
    expect(page.pageWidthPt).toBeLessThan(page.pageHeightPt);
  });

  it("near-square photo on A4 → page stays portrait (rotation doesn't help)", () => {
    const { page } = layoutOne(item("p1", 1000, 999), makeOptions());
    expect(page.pageWidthPt).toBeLessThan(page.pageHeightPt);
  });
});

describe("layoutGroups — cover vs contain", () => {
  it("cover crops: rendered rect equals the cell, crop centered with overflow hidden", () => {
    const { draw } = layoutOne(item("p1", 1000, 2000), makeOptions({ fit: "cover", autoRotate: false }));
    const clip = draw.clipRect;
    expect(approx(draw.w, clip.w)).toBe(true);
    expect(approx(draw.h, clip.h)).toBe(true);
    const crop = draw.sourceCropRect!;
    expect(crop).not.toBeNull();
    // Full width visible; vertical overflow cropped, centered.
    expect(approx(crop.sw, 1000, 1)).toBe(true);
    expect(crop.sh).toBeLessThan(2000);
    expect(approx(crop.sx + crop.sw / 2, 500, 1)).toBe(true);
    expect(approx(crop.sy + crop.sh / 2, 1000, 1)).toBe(true);
  });

  it("contain letterboxes: rendered rect ≤ cell, centered, no crop", () => {
    const { draw } = layoutOne(item("p1", 2000, 1000), makeOptions({ fit: "contain", autoRotate: false }));
    const clip = draw.clipRect;
    expect(draw.sourceCropRect).toBeNull();
    expect(draw.w).toBeLessThanOrEqual(clip.w + 0.5);
    expect(draw.h).toBeLessThanOrEqual(clip.h + 0.5);
    // Letterboxed horizontally on a portrait sheet → fills printable width,
    // centered vertically between the leftover strips.
    expect(approx(draw.w, clip.w, 1)).toBe(true);
    expect(approx(draw.y - clip.y, clip.h - draw.h - (draw.y - clip.y), 1)).toBe(true);
    expect(draw.background).toBe("#ffffff");
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

describe("layoutGroups — manual rotation composes with auto-rotate", () => {
  it("landscape photo with a 90° override becomes portrait → page stays portrait", () => {
    const { page: auto } = layoutOne(item("p1", 2000, 1000), makeOptions());
    expect(auto.pageWidthPt).toBeGreaterThan(auto.pageHeightPt); // landscape

    const { page: manual, draw } = layoutOne(item("p1", 2000, 1000, { rotateQuarterTurns: 1 }), makeOptions());
    expect(manual.pageWidthPt).toBeLessThan(manual.pageHeightPt); // portrait
    expect(draw.rotationDeg).toBe(90);
  });

  it("rotationDeg reflects only the manual turns", () => {
    const { draw } = layoutOne(item("p1", 1000, 1000, { rotateQuarterTurns: 3 }), makeOptions({ autoRotate: false }));
    expect(draw.rotationDeg).toBe(270);
  });
});

describe("layoutGroups — multi-photo pages", () => {
  it("two photos in one group share a page, split into equal-width columns", () => {
    const items = [item("p1", 1000, 1000), item("p2", 1000, 1000)];
    const itemsById = Object.fromEntries(items.map((it) => [it.id, it]));
    const groups: PageGroup[] = [{ id: "g1", itemIds: ["p1", "p2"] }];
    const [page] = layoutGroups(groups, itemsById, {}, makeOptions({ autoRotate: false }));
    expect(page.placements).toHaveLength(2);
    const [a, b] = page.placements;
    expect(approx(a.wPt, b.wPt)).toBe(true);
    expect(approx(a.xPt + a.wPt, b.xPt)).toBe(true);
  });

  it("a manual override wins over the auto column split", () => {
    const items = [item("p1", 1000, 1000), item("p2", 1000, 1000)];
    const itemsById = Object.fromEntries(items.map((it) => [it.id, it]));
    const groups: PageGroup[] = [{ id: "g1", itemIds: ["p1", "p2"] }];
    const overridesById = { p1: { xPt: 10, yPt: 10, wPt: 50, hPt: 50 } };
    const [page] = layoutGroups(groups, itemsById, overridesById, makeOptions({ autoRotate: false }));
    const a = page.placements.find((p) => p.photoId === "p1")!;
    expect(a.xPt).toBe(10);
    expect(a.wPt).toBe(50);
  });
});

describe("estimateDpi", () => {
  it("1000px photo on a 100mm-wide printable area ≈ 254 DPI", () => {
    const page = { widthPt: 283.46, heightPt: 500 }; // 100mm wide page
    const it = item("p1", 1000, 1000);
    const { placement } = layoutOne(
      it,
      makeOptions({ page, margins: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 }, fit: "contain", autoRotate: false }),
    );
    expect(estimateDpi(it, placement)).toBeCloseTo(254, 0);
  });

  it("cover crop uses visible (cropped) width for the DPI estimate", () => {
    const it = item("p1", 2000, 2000);
    const { placement } = layoutOne(it, makeOptions({ fit: "cover", autoRotate: false }));
    const dpi = estimateDpi(it, placement);
    expect(dpi).toBeGreaterThan(100);
    expect(dpi).toBeLessThan(Infinity);
  });
});
