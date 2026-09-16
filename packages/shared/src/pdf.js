import { PDFDocument } from "pdf-lib";

// Count pages in a PDF given its raw bytes. Pure and side-effect free so it can
// be unit-tested with in-memory fixtures; each app's server reads the file off
// disk and calls this. Loader options tolerate encrypted PDFs and don't rewrite
// metadata. Throws on unreadable bytes — callers catch and fall back.
//
// Server-consumed, so this is a real .js file reached via the
// "@atba3li/shared/pdf" subpath (plain Node can't import the TS index entry).
export async function countPdfPagesFromBuffer(buffer) {
  const pdfDoc = await PDFDocument.load(buffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return pdfDoc.getPageCount();
}
