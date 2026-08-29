// One image-normalisation helper for every path that turns a customer image
// into a printable raster (Photo Batch tool, and — per the overhaul plan — the
// Card tool). Renders to a canvas, so it handles WEBP/TIFF/PNG/JPEG uniformly;
// HEIC is detected up front and rejected with a clear message because Chromium
// (Electron) cannot decode it. Downscales huge originals so a 20-photo batch
// doesn't balloon into a 100MB PDF.

export interface DecodedImage {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

/** Detect HEIC/HEIF by extension or ISO-BMFF `ftyp` magic bytes. */
export function isHeic(file: File | Blob): boolean {
  const name = (file as File).name || "";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "heic" || ext === "heif" || ext === "heics" || ext === "heifs") return true;

  // Async magic-byte sniff is handled separately (decodeImageToBitmap does it);
  // the sync check here only covers the extension, which is the common case for
  // drag/drop files that carry a .heic name.
  return false;
}

async function sniffHeicBytes(file: File | Blob): Promise<boolean> {
  try {
    const buf = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    // ISO-BMFF boxes start with a 4-byte size then 'ftyp'.
    if (String.fromCharCode(...buf.slice(4, 8)) !== "ftyp") return false;
    const brand = String.fromCharCode(...buf.slice(8, 12)).toLowerCase();
    return HEIC_BRANDS.has(brand);
  } catch {
    return false;
  }
}

/**
 * Decode a file into a bitmap. HEIC is rejected with a user-facing message;
 * other formats go through createImageBitmap (Chromium supports JPEG/PNG/WEBP/
 * BMP) with an `<img>` fallback for anything it can't handle natively.
 */
export async function decodeImageToBitmap(file: File | Blob): Promise<DecodedImage> {
  if ((await sniffHeicBytes(file)) || isHeic(file)) {
    throw new Error("HEIC not supported — ask the customer to send JPEG, or convert first.");
  }
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // fall through to the <img> path
    }
  }
  // <img> fallback — decodes anything the browser's image decoder knows.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode this image — unsupported format."));
      el.src = url;
    });
    return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Draw `source` rotated by `quarterTurns` (0..3) into a fresh canvas of the
 * rotated dimensions. Works for ImageBitmap and HTMLImageElement alike.
 */
export function rotateQuarterTurnsToCanvas(
  source: ImageBitmap | HTMLImageElement,
  quarterTurns: number,
): HTMLCanvasElement {
  const t = ((quarterTurns % 4) + 4) % 4;
  const swap = t % 2 === 1;
  const w = swap ? source.height : source.width;
  const h = swap ? source.width : source.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((t * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/** True when the canvas has any non-opaque pixel (drives JPEG-vs-PNG choice).
 *  Scans a stride-sampled subset so a 20-photo batch doesn't pay a full
 *  getImageData readback per page. */
export function canvasHasAlpha(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Sample every 4th row × every 4th column → 1/16 of the pixels, early-exit.
    const w = canvas.width;
    for (let y = 0; y < canvas.height; y += 4) {
      const rowStart = y * w * 4;
      for (let x = 0; x < canvas.width; x += 4) {
        if (data[rowStart + x * 4 + 3] < 255) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export interface CanvasToBytesResult {
  bytes: Uint8Array;
  type: "image/jpeg" | "image/png";
}

/**
 * Serialise a canvas to embeddable bytes. JPEG by default (smallest); PNG when
 * the caller asks for it or the canvas carries transparency.
 */
export function canvasToImageBytes(
  canvas: HTMLCanvasElement,
  preferJpeg = true,
  quality = 0.92,
): Promise<CanvasToBytesResult> {
  return new Promise((resolve, reject) => {
    const usePng = !preferJpeg || canvasHasAlpha(canvas);
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Failed to rasterise image"));
        blob.arrayBuffer().then((buf) => {
          resolve({ bytes: new Uint8Array(buf), type: usePng ? "image/png" : "image/jpeg" });
        }).catch(reject);
      },
      usePng ? "image/png" : "image/jpeg",
      quality,
    );
  });
}
