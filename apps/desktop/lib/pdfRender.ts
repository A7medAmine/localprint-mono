// The one and only front-end PDF-rasterisation path.
//
// Browsers/Electron do NOT rasterise PDF inside an <img> element, so anything
// that needs to *see* a PDF page (Studio thumbnails, the preview modal, the
// Card/ID tool's front/back source images) must go through pdf.js. This module
// owns the dynamic import + polyfilled worker setup so there is a single code
// path, not one per caller.

import { getPdfWorkerUrl } from "./pdfWorker";

let pdfjsLib: any = null;

/** Lazily import pdf.js and point it at the shared polyfilled worker. */
export async function getPdfjs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = getPdfWorkerUrl();
  pdfjsLib = pdfjs;
  return pdfjsLib;
}

/**
 * Render the first page of a PDF to a PNG data URL.
 * @param data   the PDF bytes (ArrayBuffer or typed array)
 * @param maxPx  longest-edge target in device pixels (default 1000)
 */
export async function renderPdfFirstPageToDataUrl(
  data: ArrayBuffer | Uint8Array,
  maxPx = 1000,
): Promise<string> {
  const pdfjs = await getPdfjs();
  // pdf.js transfers/detaches the buffer it's given — hand it a copy so the
  // caller's ArrayBuffer stays usable.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxPx / base.width, maxPx / base.height, 4);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    try { doc.destroy(); } catch { /* noop */ }
  }
}
