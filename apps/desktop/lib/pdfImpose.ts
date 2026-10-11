// Pure imposition math for the PDF studio: page-range parsing, N-up cell
// layout and placing a (possibly rotated) source page inside a cell. No
// pdf-lib / DOM here so it stays unit-testable; the studio feeds the results
// straight into `PDFPage.drawPage`.

export type NUp = 1 | 2 | 4;
export type ScaleMode = "fit" | "actual";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parse a 1-based page-range string ("1-3, 5, 8-") into 0-based indices, in
 * the order written. An open end ("8-") runs to the last page; a reversed
 * range ("5-3") is read backwards. Returns null for anything malformed or out
 * of range, so the caller can flag the input instead of printing the wrong
 * pages.
 */
export function parsePageRange(input: string, total: number): number[] | null {
  const text = input.trim();
  if (!text || total < 1) return null;
  const out: number[] = [];
  for (const raw of text.split(/[,،;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) return null;
    const hasDash = !!m[2];
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = hasDash ? (m[3] ? parseInt(m[3], 10) : total) : a;
    if (!hasDash && m[3]) return null;
    if (a < 1 || b < 1 || a > total || b > total) return null;
    const step = a <= b ? 1 : -1;
    for (let p = a; p !== b + step; p += step) out.push(p - 1);
  }
  return out.length > 0 ? out : null;
}

/**
 * Output sheet size for an N-up layout. 2-up turns the sheet landscape so two
 * portrait pages sit side by side; 1-up and 4-up keep the paper as given.
 */
export function sheetSizeFor(paper: [number, number], nUp: NUp): [number, number] {
  const [w, h] = paper;
  if (nUp === 2) return [Math.max(w, h), Math.min(w, h)];
  return [w, h];
}

/**
 * Cells of one sheet in PDF space (origin bottom-left), in reading order:
 * left-to-right, top-to-bottom — or right-to-left when `rtl` (Arabic
 * documents are read from the right, so page 1 belongs on the right).
 */
export function nUpCells(sheetW: number, sheetH: number, nUp: NUp, gap = 0, rtl = false): Rect[] {
  const cols = nUp === 1 ? 1 : 2;
  const rows = nUp === 4 ? 2 : 1;
  const cw = (sheetW - gap * (cols - 1)) / cols;
  const ch = (sheetH - gap * (rows - 1)) / rows;
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = rtl ? cols - 1 - c : c;
      cells.push({
        x: col * (cw + gap),
        y: sheetH - (r + 1) * ch - r * gap,
        w: cw,
        h: ch,
      });
    }
  }
  return cells;
}

export interface DrawPagePlacement {
  x: number;
  y: number;
  /** Unrotated drawn size — what `drawPage` takes as width/height. */
  width: number;
  height: number;
  /** Counter-clockwise degrees, as `drawPage`'s `rotate` expects. */
  rotateCcw: number;
}

/**
 * Centre a source page of size srcW×srcH, turned `rotationCw` degrees
 * clockwise (the PDF /Rotate convention), inside `cell`. "fit" scales up or
 * down to fill the cell; "actual" keeps 100% and only shrinks pages that would
 * not fit.
 */
export function placePageInCell(
  srcW: number,
  srcH: number,
  rotationCw: number,
  cell: Rect,
  mode: ScaleMode,
): DrawPagePlacement {
  const rot = ((rotationCw % 360) + 360) % 360;
  const quarter = rot % 180 !== 0;
  const rw = quarter ? srcH : srcW;
  const rh = quarter ? srcW : srcH;
  const fitScale = Math.min(cell.w / rw, cell.h / rh);
  const scale = mode === "fit" ? fitScale : Math.min(1, fitScale);
  const dw = rw * scale;
  const dh = rh * scale;
  const bx = cell.x + (cell.w - dw) / 2;
  const by = cell.y + (cell.h - dh) / 2;
  const width = srcW * scale;
  const height = srcH * scale;
  // drawPage rotates around (x, y); pick the corner that lands the rotated
  // page exactly on the [bx, by, dw, dh] box.
  switch (rot) {
    case 90:
      return { x: bx, y: by + dh, width, height, rotateCcw: -90 };
    case 180:
      return { x: bx + dw, y: by + dh, width, height, rotateCcw: -180 };
    case 270:
      return { x: bx + dw, y: by, width, height, rotateCcw: -270 };
    default:
      return { x: bx, y: by, width, height, rotateCcw: 0 };
  }
}

/** Sheets needed for `pageCount` pages at `nUp` per sheet. */
export function sheetCount(pageCount: number, nUp: NUp): number {
  return Math.ceil(Math.max(0, pageCount) / nUp);
}

/**
 * Physical sheets of paper a job uses, counting both sides of a duplex sheet
 * as one and padding each copy to whole sheets.
 */
export function physicalSheets(sides: number, copies: number, duplex: boolean): number {
  const perCopy = duplex ? Math.ceil(sides / 2) : sides;
  return perCopy * Math.max(1, copies);
}
