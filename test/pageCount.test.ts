import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { countPagesForFile } from "../services/pageCountService.js";

// Contract for the server-side pdf-lib page counter (Phase 4.2 → shared pdf.ts).
// Fixtures are generated at runtime (deterministic, no committed binaries).

let dir: string;
let onePage: string;
let threePage: string;
let garbage: string;

async function writePdf(pages: number, file: string) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  fs.writeFileSync(file, await doc.save());
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-pagecount-"));
  onePage = path.join(dir, "one.pdf");
  threePage = path.join(dir, "three.pdf");
  garbage = path.join(dir, "bad.pdf");
  await writePdf(1, onePage);
  await writePdf(3, threePage);
  fs.writeFileSync(garbage, Buffer.from("not a real pdf at all"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("countPagesForFile", () => {
  it("counts a single-page PDF", async () => {
    expect(await countPagesForFile(onePage, "application/pdf")).toBe(1);
  });

  it("counts a multi-page PDF", async () => {
    expect(await countPagesForFile(threePage, "application/pdf")).toBe(3);
  });

  it("returns 1 for images without reading pages", async () => {
    expect(await countPagesForFile(onePage, "image/png")).toBe(1);
  });

  it("falls back to 1 when the PDF is unreadable", async () => {
    expect(await countPagesForFile(garbage, "application/pdf")).toBe(1);
  });

  it("estimates DOCX pages from file size", async () => {
    // estimateDocxPages: max(1, round((size - 40000) / 8000))
    const docx = path.join(dir, "doc.docx");
    fs.writeFileSync(docx, Buffer.alloc(40000 + 8000 * 3)); // → 3
    expect(await countPagesForFile(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(3);

    const tiny = path.join(dir, "tiny.docx");
    fs.writeFileSync(tiny, Buffer.alloc(1000)); // negative → clamped to 1
    expect(await countPagesForFile(tiny, "application/msword")).toBe(1);
  });

  it("returns 1 for a missing file (catch path)", async () => {
    expect(await countPagesForFile(path.join(dir, "nope.pdf"), "application/pdf")).toBe(1);
  });
});
