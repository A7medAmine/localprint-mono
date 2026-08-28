import { PDFDocument } from "pdf-lib";

// Count pages in a PDF given its raw bytes. Pure and side-effect free so it can
// be unit-tested with in-memory fixtures; server.js reads the file off disk and
// calls this. Loader options mirror the inline counter it replaced (tolerate
// encrypted PDFs, don't rewrite metadata). Throws on unreadable bytes — the
// caller in server.js catches and returns null.
export async function countPdfPagesFromBuffer(buffer) {
  const pdfDoc = await PDFDocument.load(buffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return pdfDoc.getPageCount();
}
