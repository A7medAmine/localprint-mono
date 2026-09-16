// Everything about a file arriving on disk: multer wiring, the magic-byte
// check, and the page count the admin list shows.
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { PDFDocument } from "pdf-lib";
import { ALLOWED_MIMES, magicBytesMatch } from "@localprint/shared/validation";
import { makeRateLimiter } from "@localprint/shared/http";
import db from "../db.js";
import { UPLOADS_DIR } from "./config.js";

// Signatures + the pure matcher live in @localprint/shared/validation
// (importable + tested); this wrapper does the disk read the server needs.
export function validateMagicBytes(filePath, mimeType) {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  return magicBytesMatch(buf, mimeType);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const randomName = randomBytes(16).toString("hex");
    cb(null, randomName + path.extname(file.originalname));
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Allowed: PDF, DOCX, XLSX, JPEG, PNG, TIFF`));
    }
  },
});

export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Public upload: 30 files / 5 min / IP is generous for a walk-in customer but
// caps disk-fill / job-spam from the LAN.
export const uploadLimit = makeRateLimiter({
  windowMs: 300_000,
  max: 30,
  message: "Upload limit reached. Please wait a few minutes.",
});

/**
 * PDF page count via pdf-lib. Handles encrypted and malformed PDFs gracefully.
 *
 * @param {string} filePath - Absolute path to the PDF file on disk.
 * @returns {Promise<number|null>} Page count, or null if the file cannot be read.
 */
export const getPdfPageCount = async (filePath) => {
  try {
    const fileBuffer = fs.readFileSync(filePath);

    // ignoreEncryption: true  — prevents a crash on password-protected PDFs
    //   (page count is still readable even for encrypted docs)
    // updateMetadata: false   — skip rewriting metadata; we only need page count
    const pdfDoc = await PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    const pageCount = pdfDoc.getPageCount();
    console.log(`📄 PDF page count for ${path.basename(filePath)}: ${pageCount}`);
    return pageCount;
  } catch (err) {
    console.error(`❌ Error reading PDF page count for ${path.basename(filePath)}:`, err.message);
    return null;
  }
};

/**
 * Page count for any supported upload, computed server-side so the admin list
 * never has to download files to work it out.
 *
 * @param {string} filePath - Absolute path to the stored file.
 * @param {string} mimeType - Claimed MIME type (already magic-byte validated).
 * @param {number} fileSize - Size in bytes, used by the size heuristics.
 * @returns {Promise<number|null>} Page count, or null if it cannot be derived.
 */
export const computePageCount = async (filePath, mimeType, fileSize) => {
  const type = String(mimeType || "").toLowerCase();

  if (type.includes("pdf")) return await getPdfPageCount(filePath);
  if (type.startsWith("image/")) return 1;

  const size =
    Number(fileSize) ||
    (() => {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    })();

  if (type.includes("word") || type.includes("document")) {
    // DOCX is a ZIP; docProps/app.xml carries <Pages>N</Pages> uncompressed
    // often enough to be worth a scan before falling back to the size estimate.
    try {
      const bytes = fs.readFileSync(filePath);
      const match = bytes.toString("latin1").match(/<Pages>(\d+)<\/Pages>/);
      if (match) return Math.max(1, parseInt(match[1], 10));
    } catch (err) {
      console.warn(`⚠️  Could not scan ${path.basename(filePath)} for a page count:`, err.message);
    }
    // ~40KB of container overhead, then ~8KB per page of text.
    return Math.max(1, Math.round((size - 40000) / 8000));
  }

  return Math.max(1, Math.ceil(size / 75000));
};

/** One-off pass at startup for jobs stored before page counting existed. */
export const backfillPageCounts = async () => {
  const jobsMissingCount = db
    .prepare(
      `
    SELECT * FROM jobs
    WHERE pageCount IS NULL OR pageCount = 0
  `,
    )
    .all();

  if (jobsMissingCount.length === 0) {
    console.log("✅ All jobs already have page counts.");
    return;
  }

  console.log(`📚 Backfilling page counts for ${jobsMissingCount.length} job(s)...`);

  const updateStmt = db.prepare("UPDATE jobs SET pageCount = ? WHERE id = ?");

  for (const job of jobsMissingCount) {
    if (!job.serverFileName) {
      console.warn(`  ⚠️  Job ${job.id} has no serverFileName — skipping.`);
      continue;
    }
    const filePath = path.join(UPLOADS_DIR, job.serverFileName);
    if (fs.existsSync(filePath)) {
      const count = await computePageCount(filePath, job.fileType, job.fileSize);
      if (count !== null) {
        updateStmt.run(count, job.id);
        console.log(`  ✅ ${job.fileName}: ${count} page(s)`);
      } else {
        console.warn(`  ⚠️  Could not count pages for ${job.fileName} — file may be corrupted.`);
      }
    } else {
      console.warn(`  ⚠️  File not found for job ${job.id}`);
    }
  }
};
