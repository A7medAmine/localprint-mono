// Pure photo-page layout engine. No React, no DOM (an offscreen canvas may be
// passed in by consumers for rendering, but the math here is framework-free
// and unit-tested).
//
// Concept: a page is a `PageGroup` of one or more photos. Each photo gets a
// `Placement` — a manual position + size in page points. A group with a
// single photo defaults to filling the whole printable area (today's
// full-page behavior); a group with several photos gets an initial
// equal-width column split that the UI then lets the operator drag/resize
// freely. Consumers (the preview grid and the PDF builder) resolve each
// placement's crop/letterbox via `resolvePlacementDraw`.

export type ObjectFit = "cover" | "contain";

export interface PageSpec {
  // Printable page in points (1pt = 1/72in), portrait values by convention.
  // The engine swaps them when auto-rotate decides a single-photo page wants
  // landscape.
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
  // Per-photo defaults (used only when no placement override exists).
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
  // The placement's own rect (its "cell"). For `cover` the photo fills it;
  // for `contain` the letterbox background fills the leftover around `draw`.
  clipRect: { x: number; y: number; w: number; h: number };
  // For `cover`: the visible region of the source, in rotated source pixels.
  sourceCropRect: SourceCropRect | null;
  // Manual quarter turns × 90°, for the renderer to pre-rotate the source.
  rotationDeg: number;
  // Letterbox color used by `contain` (baked into the PDF, painted by preview).
  background: string;
}

// One photo's manual position + size on its page, in page points.
export interface Placement {
  photoId: string;
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
  rotateQuarterTurns: 0 | 1 | 2 | 3;
  objectFit: ObjectFit;
}

// A manual edit to a placement — undefined fields fall back to the
// auto-computed value. Keyed by photoId in the caller's state.
export interface PlacementOverride {
  xPt?: number;
  yPt?: number;
  wPt?: number;
  hPt?: number;
  rotateQuarterTurns?: 0 | 1 | 2 | 3;
  objectFit?: ObjectFit;
}

// The photos sharing one physical page.
export interface PageGroup {
  id: string;
  itemIds: string[];
}

export interface LaidOutPage {
  // Effective page size — already swapped to landscape for a single-photo
  // group when auto-rotate fired.
  pageWidthPt: number;
  pageHeightPt: number;
  placements: Placement[];
}

export const MM_TO_PT = 72 / 25.4;

export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

// Auto-rotate threshold: rotate the page to landscape only when it gains at
// least 1% in rendered photo area. Near-square photos therefore keep the page
// portrait instead of flipping pointlessly. Only applies to single-photo
// pages — a multi-photo page's orientation is ambiguous, so it always uses
// the base page orientation.
const AUTO_ROTATE_GAIN = 0.01;

// Smallest a placement may be resized to, in page points (~7mm).
export const MIN_PLACEMENT_PT = 20;

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

function effectiveDims(naturalWidth: number, naturalHeight: number, rotateQuarterTurns: number): { w: number; h: number } {
  const manualOdd = (rotateQuarterTurns ?? 0) % 2 === 1;
  return manualOdd ? { w: naturalHeight, h: naturalWidth } : { w: naturalWidth, h: naturalHeight };
}

/**
 * Resolves one placement's crop/letterbox draw spec. Shared by the preview
 * canvas and the PDF baker so the two never drift apart.
 */
export function resolvePlacementDraw(item: PhotoItem, placement: Placement, background: string): DrawSpec {
  const clipRect = { x: placement.xPt, y: placement.yPt, w: placement.wPt, h: placement.hPt };
  const rotationDeg = (placement.rotateQuarterTurns % 4) * 90;
  const { w: effW, h: effH } = effectiveDims(item.naturalWidth, item.naturalHeight, placement.rotateQuarterTurns);

  if (effW <= 0 || effH <= 0) {
    return { x: clipRect.x, y: clipRect.y, w: clipRect.w, h: clipRect.h, clipRect, sourceCropRect: null, rotationDeg, background };
  }

  if (placement.objectFit === "cover") {
    const scale = Math.max(clipRect.w / effW, clipRect.h / effH);
    const rW = effW * scale;
    const rH = effH * scale;
    return {
      x: clipRect.x,
      y: clipRect.y,
      w: clipRect.w,
      h: clipRect.h,
      clipRect,
      sourceCropRect: {
        sx: (rW - clipRect.w) / 2 / scale,
        sy: (rH - clipRect.h) / 2 / scale,
        sw: clipRect.w / scale,
        sh: clipRect.h / scale,
      },
      rotationDeg,
      background,
    };
  }

  const scale = Math.min(clipRect.w / effW, clipRect.h / effH);
  const rW = effW * scale;
  const rH = effH * scale;
  return {
    x: clipRect.x + (clipRect.w - rW) / 2,
    y: clipRect.y + (clipRect.h - rH) / 2,
    w: rW,
    h: rH,
    clipRect,
    sourceCropRect: null,
    rotationDeg,
    background,
  };
}

function resolvePlacement(
  item: PhotoItem,
  fallbackRect: { x: number; y: number; w: number; h: number },
  override: PlacementOverride | undefined,
  batchFit: ObjectFit,
): Placement {
  return {
    photoId: item.id,
    xPt: override?.xPt ?? fallbackRect.x,
    yPt: override?.yPt ?? fallbackRect.y,
    wPt: override?.wPt ?? fallbackRect.w,
    hPt: override?.hPt ?? fallbackRect.h,
    rotateQuarterTurns: override?.rotateQuarterTurns ?? item.rotateQuarterTurns ?? 0,
    objectFit: override?.objectFit ?? item.objectFit ?? batchFit,
  };
}

/**
 * Lays out one page group. Single-photo groups auto-rotate the page and fill
 * the whole printable rect (unless a manual placement override exists,
 * e.g. from a drag). Multi-photo groups get an initial equal-width column
 * split across the printable rect, again overridable per photo.
 */
export function layoutGroups(
  groups: PageGroup[],
  itemsById: Record<string, PhotoItem>,
  overridesById: Record<string, PlacementOverride>,
  options: BatchOptions,
): LaidOutPage[] {
  const pages: LaidOutPage[] = [];

  for (const group of groups) {
    const groupItems = group.itemIds.map((id) => itemsById[id]).filter((it): it is PhotoItem => !!it);
    if (groupItems.length === 0) continue;

    let pageW = options.page.widthPt;
    let pageH = options.page.heightPt;

    if (groupItems.length === 1) {
      const item = groupItems[0];
      const override = overridesById[item.id];
      const rotate = override?.rotateQuarterTurns ?? item.rotateQuarterTurns ?? 0;
      const { w: effW, h: effH } = effectiveDims(item.naturalWidth, item.naturalHeight, rotate);
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
    }

    const printable = computePrintableRect(pageW, pageH, options.margins);
    const placements: Placement[] = [];

    if (groupItems.length === 1) {
      const item = groupItems[0];
      placements.push(resolvePlacement(item, printable, overridesById[item.id], options.fit));
    } else {
      const colW = printable.w / groupItems.length;
      groupItems.forEach((item, i) => {
        const fallback = { x: printable.x + i * colW, y: printable.y, w: colW, h: printable.h };
        placements.push(resolvePlacement(item, fallback, overridesById[item.id], options.fit));
      });
    }

    pages.push({ pageWidthPt: pageW, pageHeightPt: pageH, placements });
  }

  return pages;
}

/**
 * Rendered pixels-per-inch of a placed photo. The visible source pixels (the
 * crop for `cover`, the whole image for `contain`) are stretched across the
 * printed width, so DPI = visiblePx × 72 / printedPt.
 */
export function estimateDpi(item: PhotoItem, placement: Placement): number {
  if (item.naturalWidth <= 0 || item.naturalHeight <= 0) return 0;
  const draw = resolvePlacementDraw(item, placement, "#ffffff");
  const { w: effW } = effectiveDims(item.naturalWidth, item.naturalHeight, placement.rotateQuarterTurns);
  const visW = draw.sourceCropRect ? draw.sourceCropRect.sw : effW;
  if (visW <= 0 || draw.w <= 0) return 0;
  return (visW * 72) / draw.w;
}
