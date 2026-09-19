// Download-on-selection: when the operator picks images from a search
// window, this is what actually pulls the bytes onto disk so a reprint next
// month doesn't depend on a remote host still serving the file.
//
// This is where the feature breaks in the field, so every step is defensive:
// a real browser User-Agent (many sites 403 a default Node agent), no
// Referer (some hotlink protection allows "none" but rejects a foreign
// referer), a size cap and a timeout, magic-number sniffing instead of
// trusting Content-Type, a real pixel-dimension decode instead of trusting
// SearXNG's `resolution` hint, and a downscale for anything wider than the
// shop will ever print at A4.
//
// Uses `sharp` (libvips) for dimension decoding and resizing — no
// Node-native image library was already a project dependency (the
// image-editor feature does its sharpness/clarity work in the browser via
// Canvas, not on the server), and sharp is the standard, well-maintained
// choice for this job with prebuilt binaries for the platforms this app
// ships on.
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { UPLOADS_DIR } from "../config.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BYTES = 10 * 1024 * 1024; // ~10MB
const FETCH_TIMEOUT_MS = 15_000;
const MIN_WIDTH = 900;
const MAX_WIDTH = 2000;

// Magic-number signatures for the image formats we accept. Checked against
// the actual downloaded bytes — a lying/missing Content-Type header is never
// trusted.
const SIGNATURES = [
  { ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  {
    ext: "webp",
    bytes: [0x52, 0x49, 0x46, 0x46],
    extraCheck: (buf) => buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP",
  },
  { ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

function sniffImageType(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    const matches = sig.bytes.every((byte, i) => buffer[i] === byte);
    if (matches && (!sig.extraCheck || sig.extraCheck(buffer))) return sig.ext;
  }
  return null;
}

/** Downloads a URL's bytes with a real browser UA, no Referer, a size cap and a timeout. */
async function downloadBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("Image download timed out");
      throw new Error(`Could not download image: ${err.message || "network error"}`);
    }
    if (!response.ok) {
      throw new Error(`Image host responded with ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength && declaredLength > MAX_BYTES) {
      throw new Error("Image exceeds the 10MB size cap");
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) throw new Error("Image exceeds the 10MB size cap");
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignored */
        }
        throw new Error("Image exceeds the 10MB size cap");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/** Sniffs the format, decodes real dimensions and rejects anything under MIN_WIDTH. */
async function decodeAndValidate(buffer) {
  const ext = sniffImageType(buffer);
  if (!ext) throw new Error("File is not a recognizable image (magic-number check failed)");

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new Error("Could not decode image data");
  }
  const width = metadata.width || null;
  const height = metadata.height || null;
  if (!width || !height) throw new Error("Could not determine image dimensions");
  // The engine's `resolution` hint lies (or is absent); this is the real
  // decoded width, so it is the number that actually gates print quality.
  if (width < MIN_WIDTH) {
    throw new Error(`Image is only ${width}px wide (minimum ${MIN_WIDTH}px for print quality)`);
  }
  return { ext, width, height };
}

/** Downscales anything wider than MAX_WIDTH before it ever touches disk. */
async function downscaleIfNeeded(buffer, ext, width, height) {
  if (width <= MAX_WIDTH) return { buffer, ext, width, height };

  const pipeline = sharp(buffer).resize({ width: MAX_WIDTH, withoutEnlargement: true });
  let outBuffer;
  let outExt = ext;
  if (ext === "png") {
    outBuffer = await pipeline.png().toBuffer();
  } else if (ext === "webp") {
    outBuffer = await pipeline.webp({ quality: 88 }).toBuffer();
  } else {
    // jpg and gif (gif loses animation on resize anyway) both re-encode to jpeg.
    outBuffer = await pipeline.jpeg({ quality: 88 }).toBuffer();
    outExt = "jpg";
  }
  const meta = await sharp(outBuffer).metadata();
  return {
    buffer: outBuffer,
    ext: outExt,
    width: meta.width || MAX_WIDTH,
    height: meta.height || Math.round(height * (MAX_WIDTH / width)),
  };
}

async function attemptDownload(url) {
  const raw = await downloadBytes(url);
  const { ext, width, height } = await decodeAndValidate(raw);
  return downscaleIfNeeded(raw, ext, width, height);
}

/**
 * Downloads one ImageCandidate, validates and stores it under UPLOADS_DIR,
 * and returns a ResearchImage row. Throws (with an operator-readable
 * message) on any failure — callers isolate per-image failures themselves
 * (see saveResearchImages).
 */
export async function fetchResearchImage(candidate) {
  const primaryUrl = candidate?.url;
  if (!primaryUrl || typeof primaryUrl !== "string") {
    throw new Error("Candidate has no image URL");
  }

  let processed;
  try {
    processed = await attemptDownload(primaryUrl);
  } catch (primaryErr) {
    // Fall back to the thumbnail only if it's a distinct URL — it usually
    // isn't large enough to clear MIN_WIDTH either, so failing loudly with
    // the primary error is the common (and better) outcome.
    const thumbnailUrl = candidate?.thumbnail;
    if (!thumbnailUrl || thumbnailUrl === primaryUrl) throw primaryErr;
    try {
      processed = await attemptDownload(thumbnailUrl);
    } catch {
      throw primaryErr;
    }
  }

  const id = `img_${randomBytes(8).toString("hex")}`;
  const filename = `research_${id}.${processed.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), processed.buffer);

  return {
    id,
    filename,
    sourceUrl: primaryUrl,
    sourcePage: typeof candidate.sourcePage === "string" ? candidate.sourcePage : "",
    width: processed.width,
    height: processed.height,
    caption: typeof candidate.title === "string" ? candidate.title : "",
  };
}

/**
 * Downloads a batch of candidates with per-image failure isolation — one bad
 * (hotlink-hostile, too small, timed out, ...) image never fails the whole
 * save. Returns { images, failures }.
 */
export async function saveResearchImages(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const settled = await Promise.allSettled(list.map((c) => fetchResearchImage(c)));

  const images = [];
  const failures = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      images.push(result.value);
    } else {
      failures.push({
        id: list[i]?.id,
        url: list[i]?.url,
        error: result.reason?.message || "Failed to download image",
      });
    }
  });
  return { images, failures };
}

/** Removes one research image's file from disk. Missing files are not an error. */
export function deleteResearchImageFile(filename) {
  if (!filename) return;
  const resolved = path.resolve(path.join(UPLOADS_DIR, filename));
  if (!resolved.startsWith(path.resolve(UPLOADS_DIR))) return;
  try {
    fs.unlinkSync(resolved);
  } catch {
    /* ignored — already gone, or never existed */
  }
}
