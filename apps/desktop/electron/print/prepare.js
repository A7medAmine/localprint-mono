// Turns whatever the renderer wants printed into a single print-ready PDF on
// disk. Everything the driver is unreliable about gets baked into the bytes
// here; only the settings drivers do honour are left to the spooler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nativeImage } from 'electron';
import { PDFDocument } from 'pdf-lib';

// Images are never handed to Chromium's layout engine. Rendering a bare image
// file made Chromium paint it as an "image document" on a dark UA background,
// and wrapping it in our own HTML only moved the problem: an off-screen
// BrowserWindow can still be captured mid-composite, so the printer received a
// half-painted frame — the photo over a solid black sheet. A real PDF has no
// layout, no compositor and no theme.
const IMAGE_PDF_MARGIN_PT = (8 * 72) / 25.4; // 8mm
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

export function tmpPdfPath(prefix = 'printshop-print') {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}.pdf`);
}

/**
 * Embed `imagePath` into a PDF document. pdf-lib only speaks JPEG and PNG, so
 * anything else (BMP/WEBP/GIF/TIFF) is re-encoded to PNG through Electron's
 * own image decoder first.
 */
async function embedImageForPdf(doc, imagePath, fileType) {
  const bytes = fs.readFileSync(imagePath);
  const mime = String(fileType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    try { return await doc.embedJpg(bytes); } catch { /* fall through to re-encode */ }
  } else if (mime === 'image/png') {
    try { return await doc.embedPng(bytes); } catch { /* fall through to re-encode */ }
  } else {
    // Unknown/absent MIME — try both native formats before re-encoding.
    try { return await doc.embedJpg(bytes); } catch { /* not a JPEG */ }
    try { return await doc.embedPng(bytes); } catch { /* not a PNG */ }
  }
  const decoded = nativeImage.createFromPath(imagePath);
  if (decoded.isEmpty()) {
    throw new Error('This image format could not be decoded for printing.');
  }
  return doc.embedPng(decoded.toPNG());
}

/**
 * Turn an image on disk into a single-page print-ready PDF (white sheet, image
 * centred and contained inside the margins, page orientation matched to the
 * image). Returns the temp PDF path — the caller unlinks it.
 */
export async function makeImagePrintPdf(imagePath, fileType) {
  const doc = await PDFDocument.create();
  const img = await embedImageForPdf(doc, imagePath, fileType);

  const landscape = img.width > img.height;
  const pageW = landscape ? A4_HEIGHT_PT : A4_WIDTH_PT;
  const pageH = landscape ? A4_WIDTH_PT : A4_HEIGHT_PT;
  const page = doc.addPage([pageW, pageH]);

  const boxW = pageW - IMAGE_PDF_MARGIN_PT * 2;
  const boxH = pageH - IMAGE_PDF_MARGIN_PT * 2;
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  page.drawImage(img, {
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
    width: drawW,
    height: drawH,
  });

  const pdfPath = tmpPdfPath('printshop-image');
  fs.writeFileSync(pdfPath, Buffer.from(await doc.save()));
  return pdfPath;
}

/**
 * Uncollated copies: 1,1,1,2,2,2 instead of 1,2,3,1,2,3.
 *
 * SumatraPDF has no collate token and Windows drivers disagree about what
 * "collate off" means, so the page order is built here instead and the job is
 * spooled as a single copy. Returns the new temp PDF path, or null when there
 * is nothing to do (one copy, or the document could not be parsed).
 */
export async function makeUncollatedPdf(pdfPath, copies) {
  const n = Math.max(1, Math.trunc(Number(copies) || 1));
  if (n < 2) return null;

  const src = await PDFDocument.load(fs.readFileSync(pdfPath), { ignoreEncryption: true });
  const pageCount = src.getPageCount();
  if (pageCount < 1) return null;
  // A single-page document is identical either way — let the driver do the
  // copies instead of inflating the file.
  if (pageCount === 1) return null;

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, src.getPageIndices());
  for (const page of copied) {
    for (let i = 0; i < n; i += 1) out.addPage(page);
  }

  const outPath = tmpPdfPath('printshop-uncollated');
  fs.writeFileSync(outPath, Buffer.from(await out.save()));
  return outPath;
}

/**
 * Normalize one print request to a PDF path plus the options the spooler still
 * has to pass through.
 *
 * Returns { pdfPath, options, cleanup } — `cleanup` unlinks any temp file this
 * function created (never the caller's original file).
 */
export async function preparePrintPdf({ filePath, fileType, options = {} }) {
  const temps = [];
  const cleanup = () => {
    for (const p of temps) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  };

  try {
    let pdfPath = filePath;
    if (String(fileType || '').startsWith('image/')) {
      pdfPath = await makeImagePrintPdf(filePath, fileType);
      temps.push(pdfPath);
    }

    const next = { ...options };
    if (next.collate === false && Number(next.copies) > 1) {
      const uncollated = await makeUncollatedPdf(pdfPath, next.copies);
      if (uncollated) {
        temps.push(uncollated);
        pdfPath = uncollated;
        next.copies = 1;
      }
    }

    return { pdfPath, options: next, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
