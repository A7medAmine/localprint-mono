import { describe, it, expect } from "vitest";
import { nUpCells, parsePageRange, placePageInCell, physicalSheets, sheetCount, sheetSizeFor } from "../lib/pdfImpose";
import { buildZip, crc32 } from "../lib/zip";
import { layoutGroups, tileGrid, mmToPt, type BatchOptions, type PhotoItem } from "../lib/photoLayout";

describe("parsePageRange", () => {
  it("reads single pages, ranges and open ends in written order", () => {
    expect(parsePageRange("1-3, 5, 8-", 9)).toEqual([0, 1, 2, 4, 7, 8]);
  });
  it("accepts the Arabic comma and a leading open range", () => {
    expect(parsePageRange("-2، 4", 5)).toEqual([0, 1, 3]);
  });
  it("reads a reversed range backwards", () => {
    expect(parsePageRange("3-1", 3)).toEqual([2, 1, 0]);
  });
  it("rejects out-of-range, malformed and empty input", () => {
    expect(parsePageRange("0", 5)).toBeNull();
    expect(parsePageRange("6", 5)).toBeNull();
    expect(parsePageRange("1 2", 5)).toBeNull();
    expect(parsePageRange("a-b", 5)).toBeNull();
    expect(parsePageRange("  ", 5)).toBeNull();
  });
});

describe("N-up sheets", () => {
  const A4: [number, number] = [595.28, 841.89];

  it("2-up turns the sheet landscape, 1-up and 4-up keep it", () => {
    expect(sheetSizeFor(A4, 2)).toEqual([841.89, 595.28]);
    expect(sheetSizeFor(A4, 1)).toEqual(A4);
    expect(sheetSizeFor(A4, 4)).toEqual(A4);
  });

  it("4-up cells read left-to-right, top-to-bottom in PDF space", () => {
    const cells = nUpCells(200, 400, 4);
    expect(cells).toEqual([
      { x: 0, y: 200, w: 100, h: 200 },
      { x: 100, y: 200, w: 100, h: 200 },
      { x: 0, y: 0, w: 100, h: 200 },
      { x: 100, y: 0, w: 100, h: 200 },
    ]);
  });

  it("rtl puts the first cell on the right", () => {
    expect(nUpCells(200, 100, 2, 0, true)[0].x).toBe(100);
  });

  it("counts sides and physical sheets", () => {
    expect(sheetCount(5, 2)).toBe(3);
    expect(physicalSheets(3, 2, true)).toBe(4);
    expect(physicalSheets(3, 2, false)).toBe(6);
  });
});

describe("placePageInCell", () => {
  const cell = { x: 0, y: 0, w: 100, h: 200 };

  it("fit scales a page up to the cell and centres it", () => {
    const p = placePageInCell(50, 50, 0, cell, "fit");
    expect(p).toEqual({ x: 0, y: 50, width: 100, height: 100, rotateCcw: 0 });
  });

  it("actual never enlarges", () => {
    const p = placePageInCell(50, 50, 0, cell, "actual");
    expect(p.width).toBe(50);
    expect(p.x).toBe(25);
  });

  it("a 90° page is laid on its side and lands inside the cell", () => {
    // Landscape 200×100 source turned 90° cw becomes portrait 100×200.
    const p = placePageInCell(200, 100, 90, cell, "fit");
    expect(p.rotateCcw).toBe(-90);
    expect(p.width).toBe(200);
    expect(p.height).toBe(100);
    // Rotating cw around (x, y): the page spans x..x+height, y-width..y.
    expect(p.x).toBe(0);
    expect(p.y).toBe(200);
  });

  it("180° anchors at the opposite corner", () => {
    const p = placePageInCell(100, 200, 180, cell, "fit");
    expect([p.x, p.y, p.rotateCcw]).toEqual([100, 200, -180]);
  });
});

describe("buildZip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes local headers, a central directory and the end record", async () => {
    const blob = buildZip([{ name: "a.txt", data: new TextEncoder().encode("hi") }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(1);
  });
});

describe("photo tiles (fixed photo size)", () => {
  const A4 = { widthPt: mmToPt(210), heightPt: mmToPt(297) };
  const margins = { topMm: 5, rightMm: 5, bottomMm: 5, leftMm: 5 };
  const tile = { wPt: mmToPt(35), hPt: mmToPt(45), count: 6, gapPt: mmToPt(2) };
  const item: PhotoItem = { id: "p", naturalWidth: 700, naturalHeight: 900 };
  const opts: BatchOptions = { page: A4, margins, fit: "cover", autoRotate: false, background: "#fff", copies: 1, tile };

  it("packs 35×45 ID photos 5 across and 6 down on A4", () => {
    const grid = tileGrid(A4, margins, tile, false);
    expect([grid.cols, grid.rows]).toEqual([5, 6]);
  });

  it("repeats each photo `count` times at the exact tile size", () => {
    const pages = layoutGroups([{ id: "g", itemIds: ["p"] }], { p: item }, {}, opts);
    expect(pages).toHaveLength(1);
    expect(pages[0].groupId).toBe("g");
    expect(pages[0].placements).toHaveLength(6);
    expect(pages[0].placements[0].wPt).toBeCloseTo(mmToPt(35));
  });

  it("spills onto a second page when a sheet is full", () => {
    const pages = layoutGroups([{ id: "g", itemIds: ["p"] }], { p: item }, {}, { ...opts, tile: { ...tile, count: 31 } });
    expect(pages.map((p) => p.placements.length)).toEqual([30, 1]);
  });
});

describe("placePageInCell — rotated page stays inside its cell", () => {
  // Map the source page's corners through drawPage's transform:
  // translate(x, y) · rotate(ccw) · scale — and check they fill the box.
  const corners = (p: ReturnType<typeof placePageInCell>) => {
    const r = (p.rotateCcw * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return [
      [0, 0],
      [p.width, 0],
      [0, p.height],
      [p.width, p.height],
    ].map(([u, v]) => [p.x + u * cos - v * sin, p.y + u * sin + v * cos]);
  };

  for (const rot of [0, 90, 180, 270]) {
    it(`${rot}°`, () => {
      const cell = { x: 10, y: 20, w: 300, h: 400 };
      const pts = corners(placePageInCell(200, 100, rot, cell, "fit"));
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const eps = 1e-6;
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(cell.x - eps);
      expect(Math.max(...xs)).toBeLessThanOrEqual(cell.x + cell.w + eps);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(cell.y - eps);
      expect(Math.max(...ys)).toBeLessThanOrEqual(cell.y + cell.h + eps);
    });
  }
});
