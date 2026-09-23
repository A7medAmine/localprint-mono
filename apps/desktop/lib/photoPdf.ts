// PDF builder for the Photo Batch tool. Consumes LaidOutPage[] from
// lib/photoLayout and produces one multi-page print-ready PDF — one or more
// photos per page, at their placed positions, cover-crop or contain-letterbox
// baked in.
//
// pdf-lib can only embed JPEG/PNG and has no clip API, so every page is
// rasterised on a canvas at a sane print resolution (capped so we never
// upscale past the source) and embedded as a single full-page image. That
// also keeps the PDF small: a crop hides the overflow instead of shipping
// the whole 12MP original.
import { PDFDocument } from "pdf-lib";
import type { LaidOutPage, PhotoItem } from "./photoLayout";
import { resolvePlacementDraw } from "./photoLayout";
import { canvasToImageBytes } from "./imageNormalize";
import { drawPlacements, type PhotoSource } from "./photoRender";

const MAX_DPI = 300;

/**
 * Rasterise one laid-out page onto a canvas sized so no photo is upscaled
 * past its own pixels, capped at MAX_DPI, then draws every placement via the
 * shared `drawPlacements` loop.
 */
export function bakePageToCanvas(
  page: LaidOutPage,
  itemsById: ReadonlyMap<string, PhotoItem>,
  imagesById: ReadonlyMap<string, PhotoSource>,
  targetDpi = MAX_DPI,
): HTMLCanvasElement {
  let dpi = targetDpi;
  for (const placement of page.placements) {
    const item = itemsById.get(placement.photoId);
    const src = imagesById.get(placement.photoId);
    if (!item || !src) continue;
    const draw = resolvePlacementDraw(item, placement, "#ffffff");
    const manualOdd = placement.rotateQuarterTurns % 2 === 1;
    const effW = manualOdd ? src.height : src.width;
    const visW = draw.sourceCropRect ? draw.sourceCropRect.sw : effW;
    if (visW > 0 && draw.w > 0) dpi = Math.min(dpi, (visW * 72) / draw.w);
  }

  const scale = dpi / 72;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(page.pageWidthPt * scale));
  canvas.height = Math.max(1, Math.round(page.pageHeightPt * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawPlacements(ctx, page, itemsById, imagesById, scale);
  return canvas;
}

/**
 * Build the multi-page PDF. `copies` duplicates every page (baked in here — the
 * caller must NOT pass copies to the print IPC too, or it double-multiplies).
 */
export async function buildPhotoPdf(
  pages: LaidOutPage[],
  itemsById: ReadonlyMap<string, PhotoItem>,
  images: ReadonlyMap<string, PhotoSource>,
  copies = 1,
): Promise<Blob> {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    if (page.placements.length === 0) continue;
    const canvas = bakePageToCanvas(page, itemsById, images);
    const { bytes, type } = await canvasToImageBytes(canvas);
    const img = type === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    for (let c = 0; c < Math.max(1, copies); c++) {
      const pdfPage = doc.addPage([page.pageWidthPt, page.pageHeightPt]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: page.pageWidthPt, height: page.pageHeightPt });
    }
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: "application/pdf" });
}
