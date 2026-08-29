// Pure full-page photo layout engine. No React, no DOM (an offscreen canvas may
// be passed in by consumers for rendering, but the math here is framework-free
// and unit-tested).
//
// Concept: one photo per page. For each photo the engine decides whether the
// page should be portrait or landscape (auto-rotate), applies any manual 90°
// rotation, computes the printable area from the margins, then places the
// photo with `cover` (crop) or `contain` (letterbox). Consumers render the
// result — the preview grid and the PDF builder — from the emitted LaidOutPage.

export type ObjectFit = "cover" | "contain";

export interface PageSpec {
  // Printable page in points (1pt = 1/72in), portrait values by convention.
  // The engine swaps them when auto-rotate decides the photo wants landscape.
  widthPt: number;
  heightPt: number;
}

export interface MarginSpec {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

export interface PhotoItem {
  id: string;
  // Decoded, RGBA. Optional — the layout math only needs the natural dims.
  bitmap?: ImageBitmap | HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
  // Per-photo overrides (undefined = use the batch default).
  rotateQuarterTurns?: 0 | 1 | 2 | 3; // manual, applied ON TOP of auto-rotate
  objectFit?: ObjectFit;
}

export interface BatchOptions {
  page: PageSpec;
  margins: MarginSpec;
  fit: ObjectFit; // batch default
  autoRotate: boolean;
  background: string; // "#ffffff" for contain letterbox
  copies: number; // whole-batch copies — duplicated at PDF-build stage, not here
}

export interface SourceCropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface DrawSpec {
  // Placed photo rect in page points, top-left origin, y-down (canvas space).
  x: number;
  y: number;
  w: number;
  h: number;
  // Printable area (page minus margins). For `cover` the photo fills it; for
  // `contain` the letterbox background fills the leftover around `draw`.
  clipRect: { x: number; y: number; w: number; h: number } | null;
  // For `cover`: the visible region of the source, in rotated source pixels.
  sourceCropRect: SourceCropRect | null;
  // Manual quarter turns × 90°, for the renderer to pre-rotate the source.
  rotationDeg: number;
  // Letterbox color used by `contain` (baked into the PDF, painted by preview).
  background: string;
}

export interface LaidOutPage {
  photoId: string;
  // Effective page size — already swapped to landscape when auto-rotate fired.
  pageWidthPt: number;
  pageHeightPt: number;
  draw: DrawSpec;
}

export const MM_TO_PT = 72 / 25.4;

export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

// Auto-rotate threshold: rotate the page to landscape only when it gains at
// least 1% in rendered photo area. Near-square photos therefore keep the page
// portrait instead of flipping pointlessly.
const AUTO_ROTATE_GAIN = 0.01;

/**
 * Printable rect = page minus margins (mm→pt). If the margins would swallow
 * the page, clamp them so a 2mm printable strip is always guaranteed.
 */
export function computePrintableRect(
  pageW: number,
  pageH: number,
  margins: MarginSpec,
): { x: number; y: number; w: number; h: number } {
  let left = mmToPt(margins.leftMm);
  let right = mmToPt(margins.rightMm);
  let top = mmToPt(margins.topMm);
  let bottom = mmToPt(margins.bottomMm);
  const minPt = mmToPt(2);
  let w = pageW - left - right;
  let h = pageH - top - bottom;
  if (w < minPt) {
    left = right = Math.max(0, (pageW - minPt) / 2);
    w = pageW - left - right;
  }
  if (h < minPt) {
    top = bottom = Math.max(0, (pageH - minPt) / 2);
    h = pageH - top - bottom;
  }
  return { x: left, y: top, w, h };
}

function effectiveDims(item: PhotoItem): { w: number; h: number } {
  const manualOdd = (item.rotateQuarterTurns ?? 0) % 2 === 1;
  return manualOdd
    ? { w: item.naturalHeight, h: item.naturalWidth }
    : { w: item.naturalWidth, h: item.naturalHeight };
}

export function layoutBatch(items: PhotoItem[], options: BatchOptions): LaidOutPage[] {
  const pages: LaidOutPage[] = [];
  for (const item of items) {
    const { w: effW, h: effH } = effectiveDims(item);
    const manual = (item.rotateQuarterTurns ?? 0) % 4;

    // Auto-rotate decision — swap the page to landscape when the photo is
    // landscape-ish and gains rendered area by doing so.
    let pageW = options.page.widthPt;
    let pageH = options.page.heightPt;
    if (options.autoRotate && effW > 0 && effH > 0) {
      const pw = options.page.widthPt;
      const ph = options.page.heightPt;
      const sPortrait = Math.min(pw / effW, ph / effH);
      const sLandscape = Math.min(ph / effW, pw / effH);
      if (sLandscape > sPortrait * (1 + AUTO_ROTATE_GAIN)) {
        pageW = ph;
        pageH = pw;
      }
    }

    const printable = computePrintableRect(pageW, pageH, options.margins);
    const fit = item.objectFit ?? options.fit;
    const rotationDeg = manual * 90;

    let draw: DrawSpec;
    if (fit === "cover") {
      const scale = Math.max(printable.w / effW, printable.h / effH);
      const rW = effW * scale;
      const rH = effH * scale;
      draw = {
        x: printable.x,
        y: printable.y,
        w: printable.w,
        h: printable.h,
        clipRect: { x: printable.x, y: printable.y, w: printable.w, h: printable.h },
        sourceCropRect: {
          sx: (rW - printable.w) / 2 / scale,
          sy: (rH - printable.h) / 2 / scale,
          sw: printable.w / scale,
          sh: printable.h / scale,
        },
        rotationDeg,
        background: options.background,
      };
    } else {
      const scale = Math.min(printable.w / effW, printable.h / effH);
      const rW = effW * scale;
      const rH = effH * scale;
      draw = {
        x: printable.x + (printable.w - rW) / 2,
        y: printable.y + (printable.h - rH) / 2,
        w: rW,
        h: rH,
        clipRect: { x: printable.x, y: printable.y, w: printable.w, h: printable.h },
        sourceCropRect: null,
        rotationDeg,
        background: options.background,
      };
    }

    pages.push({ photoId: item.id, pageWidthPt: pageW, pageHeightPt: pageH, draw });
  }
  return pages;
}

/**
 * Rendered pixels-per-inch of the photo on paper. The visible source pixels
 * (the crop for `cover`, the whole image for `contain`) are stretched across
 * the printed width, so DPI = visiblePx × 72 / printedPt.
 */
export function estimateDpi(item: PhotoItem, page: LaidOutPage): number {
  if (item.naturalWidth <= 0 || item.naturalHeight <= 0) return 0;
  const { w: effW } = effectiveDims(item);
  const visW = page.draw.sourceCropRect ? page.draw.sourceCropRect.sw : effW;
  if (visW <= 0 || page.draw.w <= 0) return 0;
  return (visW * 72) / page.draw.w;
}
