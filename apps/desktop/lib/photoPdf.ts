// PDF builder for the Photo Batch tool. Consumes LaidOutPage[] from
// lib/photoLayout and produces one multi-page print-ready PDF — one photo per
// page, auto-rotated pages, cover-crop or contain-letterbox baked in.
//
// pdf-lib can only embed JPEG/PNG and has no clip API, so every page is
// rasterised on a canvas at a sane print resolution (capped so we never
// upscale past the source) and embedded as a single full-printable image.
// That also keeps the PDF small: a crop hides the overflow instead of shipping
// the whole 12MP original.
import { PDFDocument } from "pdf-lib";
import type { LaidOutPage } from "./photoLayout";
import { canvasToImageBytes, rotateQuarterTurnsToCanvas } from "./imageNormalize";

export type PhotoSource = ImageBitmap | HTMLImageElement;

const MAX_DPI = 300;

/**
 * Rasterise one laid-out page onto a canvas sized to its printable area, with
 * the photo rotated / cropped / letterboxed exactly as `layoutBatch` computed.
 */
export function bakePageToCanvas(
  page: LaidOutPage,
  src: PhotoSource,
  targetDpi = MAX_DPI,
): HTMLCanvasElement {
  const clip = page.draw.clipRect ?? { x: 0, y: 0, w: page.pageWidthPt, h: page.pageHeightPt };
  const srcW = src.width;
  const srcH = src.height;
  const manualOdd = ((page.draw.rotationDeg / 90) % 4) % 2 === 1;
  const effW = manualOdd ? srcH : srcW;
  const visW = page.draw.sourceCropRect ? page.draw.sourceCropRect.sw : effW;
  // Cap the DPI so a low-res source is never upscaled past its pixels.
  const dpi = Math.min(targetDpi, visW > 0 && clip.w > 0 ? (visW * 72) / clip.w : targetDpi);
  const cw = Math.max(1, Math.round((clip.w * dpi) / 72));
  const ch = Math.max(1, Math.round((clip.h * dpi) / 72));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;

  const drawSrc = page.draw.rotationDeg ? rotateQuarterTurnsToCanvas(src, page.draw.rotationDeg / 90) : src;

  if (page.draw.sourceCropRect) {
    const { sx, sy, sw, sh } = page.draw.sourceCropRect;
    ctx.drawImage(drawSrc, sx, sy, sw, sh, 0, 0, cw, ch);
  } else {
    const scale = Math.min(cw / drawSrc.width, ch / drawSrc.height);
    const rw = drawSrc.width * scale;
    const rh = drawSrc.height * scale;
    ctx.fillStyle = page.draw.background;
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(drawSrc, (cw - rw) / 2, (ch - rh) / 2, rw, rh);
  }
  return canvas;
}

/**
 * Build the multi-page PDF. `copies` duplicates every page (baked in here — the
 * caller must NOT pass copies to the print IPC too, or it double-multiplies).
 */
export async function buildPhotoPdf(
  pages: LaidOutPage[],
  images: ReadonlyMap<string, PhotoSource>,
  copies = 1,
): Promise<Blob> {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const src = images.get(page.photoId);
    if (!src) continue;
    const canvas = bakePageToCanvas(page, src);
    const { bytes, type } = await canvasToImageBytes(canvas);
    const img = type === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    for (let c = 0; c < Math.max(1, copies); c++) {
      const pdfPage = doc.addPage([page.pageWidthPt, page.pageHeightPt]);
      const clip = page.draw.clipRect ?? { x: 0, y: 0, w: page.pageWidthPt, h: page.pageHeightPt };
      pdfPage.drawImage(img, {
        x: clip.x,
        // pdf-lib uses a bottom-left origin; the engine emits top-left (canvas).
        y: page.pageHeightPt - clip.y - clip.h,
        width: clip.w,
        height: clip.h,
      });
    }
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: "application/pdf" });
}
