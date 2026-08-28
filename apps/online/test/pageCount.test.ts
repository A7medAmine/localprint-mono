import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { countPdfPagesFromBuffer } from "@localprint/shared/pdf";

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return await doc.save();
}

describe("countPdfPagesFromBuffer", () => {
  it("counts a single-page PDF", async () => {
    expect(await countPdfPagesFromBuffer(await makePdf(1))).toBe(1);
  });

  it("counts a multi-page PDF", async () => {
    expect(await countPdfPagesFromBuffer(await makePdf(5))).toBe(5);
  });

  it("throws on bytes that are not a PDF", async () => {
    await expect(countPdfPagesFromBuffer(Uint8Array.from([1, 2, 3, 4]))).rejects.toBeTruthy();
  });
});
