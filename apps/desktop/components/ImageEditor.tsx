import React, { useState, useRef, useEffect, useCallback } from "react";
import { Language } from "../types";
import { TRANSLATIONS } from "../constants";

interface Point {
  x: number;
  y: number;
}

interface ImageEditorProps {
  imageBlob: Blob;
  lang: Language;
  onSave: (newBlob: Blob) => void;
  onCancel: () => void;
}

interface FilterValues {
  brightness: number;
  contrast: number;
  denoise: number;
  sharpness: number;
  clarity: number;
  upscale: number;
}

interface FilterPreset extends FilterValues {
  name: string;
}

const DEFAULT_FILTERS: FilterValues = {
  brightness: 100,
  contrast: 100,
  denoise: 0,
  sharpness: 0,
  clarity: 0,
  upscale: 1,
};

const FILTER_STORAGE_KEY = "ps_editor_presets";

function filterValuesToCss(f: FilterValues): string {
  const parts = [`brightness(${f.brightness}%)`, `contrast(${f.contrast}%)`];
  if (f.denoise > 0) {
    parts.push(`blur(${(f.denoise / 100 * 1.2).toFixed(2)}px)`);
  }
  return parts.join(" ");
}

function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: FilterPreset[]) {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(presets));
}

function computeHomography(
  src: { x: number; y: number }[],
  dst: { x: number; y: number }[],
): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: X, y: Y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]);
    b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]);
    b.push(v);
  }
  const h = gaussianElimination(A, b);
  return [...h, 1];
}

function applyHomography(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

function gaussianElimination(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

function invertMatrix3x3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, k] = m;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;
  const inv = 1 / det;
  return [
    (e * k - f * h) * inv, (c * h - b * k) * inv, (b * f - c * e) * inv,
    (f * g - d * k) * inv, (a * k - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

function bilinearSample(
  src: ImageData,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  const idx = (px: number, py: number) => (clamp(py, h) * w + clamp(px, w)) * 4;
  const sample = (px: number, py: number): [number, number, number, number] => {
    const i = idx(px, py);
    return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
  };
  const tl = sample(x0, y0), tr = sample(x1, y0);
  const bl = sample(x0, y1), br = sample(x1, y1);
  return [0, 1, 2, 3].map((c) =>
    Math.round(
      tl[c] * (1 - fx) * (1 - fy) +
      tr[c] * fx * (1 - fy) +
      bl[c] * (1 - fx) * fy +
      br[c] * fx * fy,
    ),
  ) as [number, number, number, number];
}

// Convolution helpers
function applyConv3x3(data: ImageData, w: number, h: number, kernel: number[], strength: number): ImageData {
  if (strength <= 0) return data;
  const src = new Uint8ClampedArray(data.data);
  const out = data.data;
  const k = kernel;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += src[((y + dy) * w + (x + dx)) * 4 + c] * k[ki++];
          }
        }
        const orig = src[i + c];
        out[i + c] = Math.round(orig + (sum - orig) * strength);
      }
      out[i + 3] = src[i + 3];
    }
  }
  return data;
}

function applyClarity(data: ImageData, w: number, h: number, strength: number): ImageData {
  if (strength <= 0) return data;
  const src = new Uint8ClampedArray(data.data);
  const out = data.data;
  const blurKernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const blurDiv = 16;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let blurred = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            blurred += src[((y + dy) * w + (x + dx)) * 4 + c] * blurKernel[ki++];
          }
        }
        blurred /= blurDiv;
        const detail = src[i + c] - blurred;
        out[i + c] = Math.round(src[i + c] + detail * (strength * 1.2));
      }
      out[i + 3] = src[i + 3];
    }
  }
  return data;
}

const RANGE_SLIDER_CLASS = "w-full h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full appearance-none cursor-pointer accent-indigo-600";

const ImageEditor: React.FC<ImageEditorProps> = ({
  imageBlob,
  lang,
  onSave,
  onCancel,
}) => {
  const t = (key: string) => TRANSLATIONS[key][lang];
  const isRtl = lang === "ar";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<"edit" | "crop" | "perspective">("edit");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [filters, setFilters] = useState<FilterValues>({ ...DEFAULT_FILTERS });
  const [presets, setPresets] = useState<FilterPreset[]>(loadPresets);
  const [presetNameInput, setPresetNameInput] = useState("");

  const [baseSize, setBaseSize] = useState({ width: 0, height: 0 });

  const [cropRect, setCropRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  }>({ x: 50, y: 50, w: 200, h: 200 });
  const [points, setPoints] = useState<Point[]>([
    { x: 50, y: 50 },
    { x: 250, y: 50 },
    { x: 250, y: 250 },
    { x: 50, y: 250 },
  ]);

  const [dragIdx, setDragIdx] = useState<number | "rect" | null>(null);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [globalMousePos, setGlobalMousePos] = useState<Point>({ x: 0, y: 0 });

  useEffect(() => {
    const img = new Image();
    const url = URL.createObjectURL(imageBlob);
    img.src = url;
    img.onload = () => {
      setImage(img);
      const maxWidth = window.innerWidth * 0.65;
      const maxHeight = window.innerHeight * 0.75;

      let w = img.width;
      let h = img.height;

      if (w > maxWidth) {
        h = (maxWidth / w) * h;
        w = maxWidth;
      }
      if (h > maxHeight) {
        w = (maxHeight / h) * w;
        h = maxHeight;
      }

      setBaseSize({ width: w, height: h });
      setPoints([
        { x: w * 0.1, y: h * 0.1 },
        { x: w * 0.9, y: h * 0.1 },
        { x: w * 0.9, y: h * 0.9 },
        { x: w * 0.1, y: h * 0.9 },
      ]);
      setCropRect({ x: w * 0.2, y: h * 0.2, w: w * 0.6, h: h * 0.6 });
    };
    return () => URL.revokeObjectURL(url);
  }, [imageBlob]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDragging && dragIdx !== null) {
        setGlobalMousePos({ x: e.clientX, y: e.clientY });
      }
    };

    const handleGlobalMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        setDragIdx(null);
      }
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleGlobalMouseMove);
      document.addEventListener("mouseup", handleGlobalMouseUp);
      return () => {
        document.removeEventListener("mousemove", handleGlobalMouseMove);
        document.removeEventListener("mouseup", handleGlobalMouseUp);
      };
    }
  }, [isDragging, dragIdx]);

  // Drive drag from globalMousePos so cursor can leave canvas
  useEffect(() => {
    if (!isDragging || dragIdx === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    const x = (globalMousePos.x - rect.left) / zoom;
    const y = (globalMousePos.y - rect.top) / zoom;

    const clampedX = Math.max(0, Math.min(baseSize.width, x));
    const clampedY = Math.max(0, Math.min(baseSize.height, y));

    if (mode === "perspective") {
      const newPoints = [...points];
      newPoints[dragIdx as number] = { x: clampedX, y: clampedY };
      setPoints(newPoints);
    } else {
      if (dragIdx === "rect") {
        const nx = Math.max(0, Math.min(baseSize.width - cropRect.w, clampedX - offset.x));
        const ny = Math.max(0, Math.min(baseSize.height - cropRect.h, clampedY - offset.y));
        setCropRect((prev) => ({ ...prev, x: nx, y: ny }));
      } else {
        const idx = dragIdx as number;
        setCropRect((prev) => {
          let { x: nx, y: ny, w: nw, h: nh } = prev;
          if (idx === 0) {
            nw += nx - clampedX;
            nh += ny - clampedY;
            nx = clampedX;
            ny = clampedY;
          } else if (idx === 1) {
            nw = clampedX - nx;
            nh += ny - clampedY;
            ny = clampedY;
          } else if (idx === 2) {
            nw = clampedX - nx;
            nh = clampedY - ny;
          } else if (idx === 3) {
            nw += nx - clampedX;
            nh = clampedY - ny;
            nx = clampedX;
          }
          return { x: nx, y: ny, w: Math.max(20, nw), h: Math.max(20, nh) };
        });
      }
    }
  }, [isDragging, dragIdx, globalMousePos, zoom, baseSize, mode, cropRect, points, offset]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || baseSize.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = baseSize.width * zoom;
    canvas.height = baseSize.height * zoom;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.filter = filterValuesToCss(filters);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Apply sharpness and clarity via pixel processing on preview
    if (filters.sharpness > 0 || filters.clarity > 0) {
      const w = canvas.width;
      const h = canvas.height;
      const imgData = ctx.getImageData(0, 0, w, h);
      if (filters.sharpness > 0) {
        const s = filters.sharpness / 100;
        applyConv3x3(imgData, w, h, [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0], 1);
      }
      if (filters.clarity > 0) {
        applyClarity(imgData, w, h, filters.clarity / 100);
      }
      ctx.putImageData(imgData, 0, 0);
    }

    if (mode === "edit") {
      ctx.filter = filterValuesToCss(filters);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return;
    }

    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";

    if (mode === "crop") {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(
        cropRect.x * zoom,
        cropRect.y * zoom,
        cropRect.w * zoom,
        cropRect.h * zoom,
      );
      ctx.fill("evenodd");

      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        cropRect.x * zoom,
        cropRect.y * zoom,
        cropRect.w * zoom,
        cropRect.h * zoom,
      );

      const handles = [
        { x: cropRect.x, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
        { x: cropRect.x, y: cropRect.y + cropRect.h },
      ];
      ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
      ctx.shadowBlur = 10;
      handles.forEach((p) => {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(p.x * zoom, p.y * zoom, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#6366f1";
        ctx.beginPath();
        ctx.arc(p.x * zoom, p.y * zoom, 7, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x * zoom, points[0].y * zoom);
      for (let i = 1; i < 4; i++)
        ctx.lineTo(points[i].x * zoom, points[i].y * zoom);
      ctx.closePath();

      ctx.save();
      ctx.clip();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.filter = filterValuesToCss(filters);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.moveTo(points[0].x * zoom, points[0].y * zoom);
      for (let i = 1; i < 4; i++)
        ctx.lineTo(points[i].x * zoom, points[i].y * zoom);
      ctx.closePath();
      ctx.fill("evenodd");

      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x * zoom, points[0].y * zoom);
      for (let i = 1; i < 4; i++)
        ctx.lineTo(points[i].x * zoom, points[i].y * zoom);
      ctx.closePath();
      ctx.stroke();

      ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
      ctx.shadowBlur = 10;
      points.forEach((p) => {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(p.x * zoom, p.y * zoom, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#6366f1";
        ctx.beginPath();
        ctx.arc(p.x * zoom, p.y * zoom, 8, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }
  }, [image, mode, points, cropRect, zoom, baseSize, filters]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (mode === "edit") return;
    const rect = canvas.getBoundingClientRect();

    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;

    const handleRadius = 30 / zoom;

    if (mode === "perspective") {
      const idx = points.findIndex(
        (p) => Math.hypot(p.x - x, p.y - y) < handleRadius,
      );
      if (idx !== -1) {
        setDragIdx(idx);
        setIsDragging(true);
        setGlobalMousePos({ x: e.clientX, y: e.clientY });
      }
    } else {
      const handles = [
        { x: cropRect.x, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
        { x: cropRect.x, y: cropRect.y + cropRect.h },
      ];
      const hIdx = handles.findIndex(
        (p) => Math.hypot(p.x - x, p.y - y) < handleRadius,
      );
      if (hIdx !== -1) {
        setDragIdx(hIdx);
        setIsDragging(true);
        setGlobalMousePos({ x: e.clientX, y: e.clientY });
      } else if (
        x > cropRect.x &&
        x < cropRect.x + cropRect.w &&
        y > cropRect.y &&
        y < cropRect.y + cropRect.h
      ) {
        setDragIdx("rect");
        setIsDragging(true);
        setOffset({ x: x - cropRect.x, y: y - cropRect.y });
        setGlobalMousePos({ x: e.clientX, y: e.clientY });
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
  };

  function processPixels(
    srcCanvas: HTMLCanvasElement,
    srcCtx: CanvasRenderingContext2D,
    filterStr: string,
    srcW: number,
    srcH: number,
  ) {
    srcCtx.filter = filterStr;
    srcCtx.drawImage(image!, 0, 0, srcW, srcH);
    const imgData = srcCtx.getImageData(0, 0, srcW, srcH);
    if (filters.sharpness > 0) {
      const s = filters.sharpness / 100;
      applyConv3x3(imgData, srcW, srcH, [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0], 1);
    }
    if (filters.clarity > 0) {
      applyClarity(imgData, srcW, srcH, filters.clarity / 100);
    }
    srcCtx.putImageData(imgData, 0, 0);
  }

  const handleApply = async () => {
    if (!image || !canvasRef.current) return;
    setIsProcessing(true);

    const scale = image.width / baseSize.width;
    const filterStr = filterValuesToCss(filters);
    const upscaleFactor = filters.upscale;

    if (mode === "edit") {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.filter = filterStr;
      ctx.drawImage(image, 0, 0);
      const imgData = ctx.getImageData(0, 0, image.width, image.height);
      if (filters.sharpness > 0) {
        const s = filters.sharpness / 100;
        applyConv3x3(imgData, image.width, image.height, [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0], 1);
      }
      if (filters.clarity > 0) {
        applyClarity(imgData, image.width, image.height, filters.clarity / 100);
      }
      ctx.putImageData(imgData, 0, 0);
      canvas.toBlob((blob) => {
        setIsProcessing(false);
        if (blob) { setPendingBlob(blob); setShowConfirm(true); }
      }, imageBlob.type);
    } else if (mode === "crop") {
      const outW = Math.round(cropRect.w * scale * upscaleFactor);
      const outH = Math.round(cropRect.h * scale * upscaleFactor);
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = outW;
      srcCanvas.height = outH;
      const srcCtx = srcCanvas.getContext("2d")!;
      srcCtx.filter = filterStr;
      srcCtx.drawImage(
        image,
        cropRect.x * scale, cropRect.y * scale,
        cropRect.w * scale, cropRect.h * scale,
        0, 0, outW, outH,
      );
      const imgData = srcCtx.getImageData(0, 0, outW, outH);
      if (filters.sharpness > 0) {
        const s = filters.sharpness / 100;
        applyConv3x3(imgData, outW, outH, [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0], 1);
      }
      if (filters.clarity > 0) {
        applyClarity(imgData, outW, outH, filters.clarity / 100);
      }
      ctx.putImageData(imgData, 0, 0);
      canvas.toBlob((blob) => {
        setIsProcessing(false);
        if (blob) { setPendingBlob(blob); setShowConfirm(true); }
      }, imageBlob.type);

    } else {
      const src = points.map((p) => ({ x: p.x * scale, y: p.y * scale }));

      let outW = Math.round(Math.max(
        Math.hypot(src[1].x - src[0].x, src[1].y - src[0].y),
        Math.hypot(src[2].x - src[3].x, src[2].y - src[3].y),
      ));
      let outH = Math.round(Math.max(
        Math.hypot(src[3].x - src[0].x, src[3].y - src[0].y),
        Math.hypot(src[2].x - src[1].x, src[2].y - src[1].y),
      ));
      outW = Math.round(outW * upscaleFactor);
      outH = Math.round(outH * upscaleFactor);

      const dst = [
        { x: 0,    y: 0    },
        { x: outW, y: 0    },
        { x: outW, y: outH },
        { x: 0,    y: outH },
      ];

      const H = computeHomography(src, dst);
      const H_inv = invertMatrix3x3(H);
      if (!H_inv) { setIsProcessing(false); return; }

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = image.width;
      srcCanvas.height = image.height;
      const srcCtx = srcCanvas.getContext("2d")!;
      srcCtx.filter = filterStr;
      srcCtx.drawImage(image, 0, 0);
      const srcData = srcCtx.getImageData(0, 0, image.width, image.height);
      const outData = ctx.createImageData(outW, outH);

      for (let dy = 0; dy < outH; dy++) {
        for (let dx = 0; dx < outW; dx++) {
          const [sx, sy] = applyHomography(H_inv, dx + 0.5, dy + 0.5);
          const color = bilinearSample(srcData, image.width, image.height, sx, sy);
          const i = (dy * outW + dx) * 4;
          outData.data[i]     = color[0];
          outData.data[i + 1] = color[1];
          outData.data[i + 2] = color[2];
          outData.data[i + 3] = color[3];
        }
      }
      ctx.putImageData(outData, 0, 0);

      const finalData = ctx.getImageData(0, 0, outW, outH);
      if (filters.sharpness > 0) {
        const s = filters.sharpness / 100;
        applyConv3x3(finalData, outW, outH, [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0], 1);
      }
      if (filters.clarity > 0) {
        applyClarity(finalData, outW, outH, filters.clarity / 100);
      }
      ctx.putImageData(finalData, 0, 0);

      canvas.toBlob((blob) => {
        setIsProcessing(false);
        if (blob) { setPendingBlob(blob); setShowConfirm(true); }
      }, imageBlob.type);
    }
  };

  const confirmSave = () => {
    if (pendingBlob) {
      onSave(pendingBlob);
    }
  };

  const updateFilter = (key: keyof FilterValues, value: number) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
  };

  const savePreset = () => {
    const name = presetNameInput.trim();
    if (!name) return;
    const newPreset: FilterPreset = { name, ...filters };
    const updated = [...presets, newPreset];
    setPresets(updated);
    savePresets(updated);
    setPresetNameInput("");
  };

  const applyPreset = (preset: FilterValues) => {
    setFilters({ ...preset });
  };

  const deletePreset = (idx: number) => {
    const updated = presets.filter((_, i) => i !== idx);
    setPresets(updated);
    savePresets(updated);
  };

  const slider = (
    label: string,
    key: keyof FilterValues,
    min: number,
    max: number,
    unit: string,
    step?: number,
  ) => (
    <div>
      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
        <span>{label}</span>
        <span className="font-mono font-bold">{filters[key]}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={filters[key]}
        onChange={(e) => updateFilter(key, Number(e.target.value))}
        className={RANGE_SLIDER_CLASS}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center p-0">
      <div className="bg-white dark:bg-gray-900 w-full h-full max-w-[98vw] max-h-[98vh] overflow-hidden flex flex-col shadow-2xl dark:shadow-gray-900/80 relative rounded-none md:rounded-2xl">
        {showConfirm && (
          <div className="absolute inset-0 z-[110] bg-black/50 flex items-center justify-center backdrop-blur-sm p-4 text-center">
            <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-2xl dark:shadow-gray-900/60 max-w-sm w-full">
              <div className="w-16 h-16 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
              </div>
              <h4 className="text-xl font-bold mb-2">
                {isRtl ? "تأكيد الحفظ؟" : "Confirm Save?"}
              </h4>
              <p className="text-gray-600 dark:text-gray-400 mb-6 text-sm">
                {isRtl
                  ? "سيتم استبدال الملف الأصلي بهذا التعديل بشكل دائم."
                  : "The original file will be permanently replaced with this edit."}
              </p>
              <div className="flex gap-3">
                <button onClick={() => setShowConfirm(false)} className="flex-1 px-4 py-2 text-gray-600 dark:text-gray-300 font-bold hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl transition">{t("cancel")}</button>
                <button onClick={confirmSave} className="flex-1 px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition shadow-lg">{t("save")}</button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/80 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-sm hidden sm:block">{t("edit")}</h3>
            <div className="flex bg-white dark:bg-gray-800 rounded-lg p-0.5 shadow-sm border border-gray-200 dark:border-gray-600">
              <button onClick={() => setMode("edit")} className={`px-2.5 py-1.5 rounded-md text-[11px] font-bold transition ${mode === "edit" ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>{t("edit")}</button>
              <button onClick={() => setMode("crop")} className={`px-2.5 py-1.5 rounded-md text-[11px] font-bold transition ${mode === "crop" ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>{t("normalCrop")}</button>
              <button onClick={() => setMode("perspective")} className={`px-2.5 py-1.5 rounded-md text-[11px] font-bold transition ${mode === "perspective" ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>{t("perspectiveCut")}</button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 bg-white dark:bg-gray-800 rounded-lg p-0.5 shadow-sm border border-gray-200 dark:border-gray-600">
            <button onClick={() => setZoom((prev) => Math.max(0.5, prev - 0.25))} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-400" title="Zoom Out">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4"></path></svg>
            </button>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((prev) => Math.min(5, prev + 0.25))} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-600 dark:text-gray-400" title="Zoom In">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            </button>
            <div className="w-px h-3 bg-gray-200 dark:bg-gray-600 mx-0.5" />
            <button onClick={() => setZoom(1)} className="px-1.5 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">{isRtl ? "إعادة" : "Reset"}</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          <div ref={containerRef} onWheel={handleWheel} className="flex-1 overflow-auto bg-gray-900/50 dark:bg-black/80 flex items-center justify-center p-2">
            <div className="relative shadow-2xl bg-white/5 dark:bg-white/10 inline-block">
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                className="cursor-crosshair bg-white dark:bg-gray-800"
                style={{ maxWidth: "none" }}
              />
            </div>
          </div>

          {/* Right sidebar */}
          <div className="w-64 border-l border-gray-100 dark:border-gray-700 bg-gray-50/30 dark:bg-gray-900/60 flex flex-col overflow-y-auto shrink-0">
            <div className="p-3 border-b border-gray-100 dark:border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{isRtl ? "التأثيرات" : "Effects"}</h4>
                <button onClick={resetFilters} className="text-[10px] text-indigo-600 font-bold hover:underline">{isRtl ? "إعادة تعيين" : "Reset"}</button>
              </div>
              <div className="space-y-2.5">
                {slider(isRtl ? "سطوع" : "Brightness", "brightness", 0, 200, "%")}
                {slider(isRtl ? "تباين" : "Contrast", "contrast", 0, 200, "%")}
                {slider(isRtl ? "تقليل الضوضاء" : "Denoise", "denoise", 0, 100, "%")}
                {slider(isRtl ? "حدة" : "Sharpness", "sharpness", 0, 100, "%")}
                {slider(isRtl ? "وضوح" : "Clarity", "clarity", 0, 100, "%")}
                {slider(isRtl ? "تكبير" : "Upscale", "upscale", 1, 4, "×", 0.5)}
              </div>
            </div>

            {/* Presets */}
            <div className="p-3 border-b border-gray-100 dark:border-gray-700">
              <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-3">{isRtl ? "الإعدادات المحفوظة" : "Presets"}</h4>
              {presets.length > 0 ? (
                <div className="space-y-1 mb-3">
                  {presets.map((p, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <button onClick={() => applyPreset(p)} className="flex-1 text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-700 dark:hover:text-indigo-400 transition border border-transparent hover:border-indigo-200 dark:hover:border-indigo-700 truncate">{p.name}</button>
                      <button onClick={() => deletePreset(i)} className="p-1 hover:bg-red-50 dark:hover:bg-red-900/20 rounded text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition" title={isRtl ? "حذف" : "Delete"}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">{isRtl ? "لا توجد إعدادات محفوظة" : "No saved presets"}</p>
              )}
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={presetNameInput}
                  onChange={(e) => setPresetNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }}
                  placeholder={isRtl ? "اسم الإعداد" : "Preset name"}
                  className="flex-1 min-w-0 text-xs px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
                <button onClick={savePreset} disabled={!presetNameInput.trim()} className="px-2.5 py-1.5 bg-indigo-600 text-white text-[11px] font-bold rounded-lg hover:bg-indigo-700 transition disabled:opacity-40 shrink-0">{isRtl ? "حفظ" : "Save"}</button>
              </div>
            </div>

            <div className="p-3 mt-auto flex flex-col gap-2">
              <button onClick={handleApply} disabled={isProcessing} className="w-full py-2.5 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition shadow-lg text-sm flex items-center justify-center gap-2">
                {isProcessing && (<svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>)}
                {isRtl ? "حفظ التغييرات" : "Save Changes"}
              </button>
              <button onClick={onCancel} className="w-full py-2 text-gray-600 dark:text-gray-400 font-bold hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl transition text-sm">{t("cancel")}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditor;
