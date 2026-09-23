// Shared 2D-canvas drawing loop for a laid-out page's placements — used by
// both the live preview canvas and the PDF baker so their crop/letterbox
// math can never drift apart from `resolvePlacementDraw`.
import type { LaidOutPage, PhotoItem } from "./photoLayout";
import { resolvePlacementDraw } from "./photoLayout";
import { rotateQuarterTurnsToCanvas } from "./imageNormalize";

export type PhotoSource = ImageBitmap | HTMLImageElement;

/**
 * Draws every placement of `page` onto `ctx`, scaled by `scale` (device px
 * per page point). A placement whose source is missing/not yet decoded is
 * filled with `placeholderColor` instead of being skipped, so the preview can
 * show a loading state.
 */
export function drawPlacements(
  ctx: CanvasRenderingContext2D,
  page: LaidOutPage,
  itemsById: ReadonlyMap<string, PhotoItem>,
  sourcesById: ReadonlyMap<string, PhotoSource | null | undefined>,
  scale: number,
  placeholderColor = "#f3f4f6",
): void {
  for (const placement of page.placements) {
    const item = itemsById.get(placement.photoId);
    if (!item) continue;
    const draw = resolvePlacementDraw(item, placement, "#ffffff");
    const clip = draw.clipRect;
    const cx = clip.x * scale;
    const cy = clip.y * scale;
    const cw = clip.w * scale;
    const ch = clip.h * scale;
    const src = sourcesById.get(placement.photoId);

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();

    if (!src) {
      ctx.fillStyle = placeholderColor;
      ctx.fillRect(cx, cy, cw, ch);
      ctx.restore();
      continue;
    }

    const drawSrc = draw.rotationDeg ? rotateQuarterTurnsToCanvas(src, draw.rotationDeg / 90) : src;
    if (draw.sourceCropRect) {
      const { sx, sy, sw, sh } = draw.sourceCropRect;
      ctx.drawImage(drawSrc, sx, sy, sw, sh, cx, cy, cw, ch);
    } else {
      ctx.fillStyle = draw.background;
      ctx.fillRect(cx, cy, cw, ch);
      ctx.drawImage(drawSrc, draw.x * scale, draw.y * scale, draw.w * scale, draw.h * scale);
    }
    ctx.restore();
  }
}
