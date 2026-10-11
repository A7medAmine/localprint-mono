import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PDFDocument, PDFImage, degrees, rgb } from "pdf-lib";
import { renderPdfPagesToDataUrls } from "../lib/pdfRender";
import LoadJobModal from "../components/LoadJobModal";
import { JobTargetPicker, useJobTargets } from "../components/JobTargetPicker";
import ImageEditor from "../components/ImageEditor";
import { useLanguage } from "../lib/useLanguage";
import { useStudioSnapshot, useStudioRestore } from "../lib/studioPersist";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "../components/ui/use-toast";
import { isElectron, printData } from "../lib/electronPrint";
import { storageService } from "../services/storageService";
import type { PrinterJobDefaults, PrintJob } from "../types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { Icon } from "../components/ui/icon";
import { cn, errorMessage } from "@atba3li/shared";

const MM_TO_PT = 2.83465;
const SCALE = 0.45;
const PAPER_SIZES: { label: string; w: number; h: number }[] = [
  { label: "A4 (210x297mm)", w: 595.28, h: 841.89 },
  { label: "A3 (297x420mm)", w: 841.89, h: 1190.55 },
  { label: "Letter (216x279mm)", w: 612, h: 792 },
];

const CARD_SIZES: { label: string; w: number; h: number }[] = [
  { label: "CR80 (ID-1) 85.6x54mm", w: 85.6, h: 54 },
  { label: "CR79 85.5x54mm", w: 85.5, h: 54 },
  { label: "CR90 92x60mm", w: 92, h: 60 },
  { label: "CR100 98.5x67mm", w: 98.5, h: 67 },
  { label: "Business Card 90x50mm", w: 90, h: 50 },
  { label: "ID-2 (A4 folded) 105x74mm", w: 105, h: 74 },
  { label: "ID-3 (Passport) 125x88mm", w: 125, h: 88 },
];

type Face = "front" | "back";
type LayoutMode = "cards" | "photocopy";

// One card face placed on an output page, in PDF space (origin bottom-left).
interface FaceDraw {
  face: Face;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CROP_PREF_KEY = "ps_card_crop_on_upload";

function readCropPref(): boolean {
  try { return localStorage.getItem(CROP_PREF_KEY) !== "0"; } catch { return true; }
}
function writeCropPref(on: boolean) {
  try { localStorage.setItem(CROP_PREF_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
}

/**
 * Read a card face. Images come back as-is; a PDF is rasterised — up to its
 * first two pages, so a scanned "front + back" PDF can fill both faces.
 */
async function readFileAsDataUrls(f: File | null | undefined): Promise<string[]> {
  if (!f) throw new Error("No file provided");
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    // <img> can't rasterise PDF — go through the shared pdf.js path.
    return renderPdfPagesToDataUrls(await f.arrayBuffer(), 2, 1600);
  }
  if (f.type.startsWith("image/")) {
    return [await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(f);
    })];
  }
  throw new Error("Unsupported file type");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function dataUrlToBlob(dataUrl: string): Blob {
  const type = dataUrl.match(/^data:([^;]+);/)?.[1] || "image/png";
  return new Blob([dataUrlToBytes(dataUrl) as BlobPart], { type });
}

function embedImageInPdf(pdfDoc: PDFDocument, dataUrl: string) {
  const isJpeg = dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg");
  const bytes = dataUrlToBytes(dataUrl);
  return isJpeg ? pdfDoc.embedJpg(bytes) : pdfDoc.embedPng(bytes);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/**
 * Centre-crop an image to the card's aspect ratio (taking the face rotation
 * into account), so "fill the card" can be drawn as a plain contain-fit both
 * in the preview and in the PDF — pdf-lib has no image clipping.
 */
async function coverCropDataUrl(dataUrl: string, cardW: number, cardH: number, rot: number): Promise<string> {
  const img = await loadImage(dataUrl);
  const quarter = rot % 180 !== 0;
  // The image is drawn rotated, so before rotation it must match the card's
  // aspect turned by the same amount.
  const target = quarter ? cardH / cardW : cardW / cardH;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  let sw = iw;
  let sh = ih;
  if (iw / ih > target) sw = ih * target;
  else sh = iw / target;
  if (Math.abs(sw - iw) < 1 && Math.abs(sh - ih) < 1) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return dataUrl.startsWith("data:image/png") ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.95);
}

// Contain-fit, where imgW/imgH are the image's OWN (pre-rotation) dimensions
// and the returned w/h are what to pass to drawImage in that same local frame —
// the caller doesn't need to swap anything back after rotating the canvas/page.
function containFitRotated(imgW: number, imgH: number, boxW: number, boxH: number, rotated: boolean) {
  const scale = rotated ? Math.min(boxW / imgH, boxH / imgW) : Math.min(boxW / imgW, boxH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

/**
 * pdf-lib rotates an image counter-clockwise around its (x, y) corner. Return
 * the corner that lands a `rot`° (clockwise, like the preview) image of drawn
 * size w×h centred on the box.
 */
function rotatedImageOrigin(box: { x: number; y: number; w: number; h: number }, w: number, h: number, rot: number) {
  const r = ((rot % 360) + 360) % 360;
  const quarter = r % 180 !== 0;
  const dw = quarter ? h : w;
  const dh = quarter ? w : h;
  const bx = box.x + (box.w - dw) / 2;
  const by = box.y + (box.h - dh) / 2;
  switch (r) {
    case 90: return { x: bx, y: by + dh, rotate: -90 };
    case 180: return { x: bx + dw, y: by + dh, rotate: -180 };
    case 270: return { x: bx + dw, y: by, rotate: -270 };
    default: return { x: bx, y: by, rotate: 0 };
  }
}

// Only a sanity ceiling — a sheet's capacity no longer caps the count, extra
// copies spill onto new sheets.
const MAX_COPIES = 999;
const clampCopies = (n: number) =>
  Math.max(1, Math.min(MAX_COPIES, Math.floor(Number.isFinite(n) ? n : 1) || 1));

const AUTO_MARGIN_MM = 5;
const AUTO_GAP_MM = 3;
// Space between the front and back of one ID photocopy set.
const PHOTOCOPY_GAP_MM = 8;
const CUT_MARK_LEN = 3 * MM_TO_PT;
const CUT_MARK_OFFSET = 1 * MM_TO_PT;

// Cards keep their real size (cardW x cardH). Pick the cols x rows split that
// wastes the fewest sheet cells for the requested copy count, then shrink the
// gap (never the card) if that's what it takes to fit the grid on the page.
function autoLayout(copies: number, cardW: number, cardH: number, pw: number, ph: number) {
  let margin = AUTO_MARGIN_MM * MM_TO_PT;
  let gap = AUTO_GAP_MM * MM_TO_PT;
  const fitCount = (g: number) => ({
    cols: Math.max(1, Math.floor((pw - 2 * margin + g) / (cardW + g))),
    rows: Math.max(1, Math.floor((ph - 2 * margin + g) / (cardH + g))),
  });
  let { cols: maxCols, rows: maxRows } = fitCount(gap);
  // Not even a single card fits with the default margin/gap — shrink both
  // until one does (falls back to 0 rather than ever resizing the card).
  while (maxCols * maxRows < 1 && (margin > 0 || gap > 0)) {
    margin = Math.max(0, margin - MM_TO_PT);
    gap = Math.max(0, gap - MM_TO_PT);
    ({ cols: maxCols, rows: maxRows } = fitCount(gap));
  }
  const capacity = maxCols * maxRows;
  const wanted = Math.max(1, Math.min(copies, capacity));

  // Fill row-major at the sheet's full width: as many cards per row as fit,
  // then wrap to the next row. A "compact/balanced" split was tried before and
  // read wrong — 3 copies became a single centred column instead of 2 + 1.
  const cols = Math.min(maxCols, wanted);
  const rows = Math.min(maxRows, Math.ceil(wanted / cols));
  const best = { cols, rows };

  const hGapPt = best.cols > 1 ? gap : 0;
  const vGapPt = best.rows > 1 ? gap : 0;
  const gridW = best.cols * cardW + (best.cols - 1) * hGapPt;
  const originX = (pw - gridW) / 2;
  const originY = margin;

  const slots: { x: number; y: number; w: number; h: number }[] = [];
  for (let row = 0; row < best.rows; row++) {
    for (let col = 0; col < best.cols; col++) {
      if (slots.length >= wanted) break;
      slots.push({
        x: originX + col * (cardW + hGapPt),
        y: ph - originY - (row + 1) * cardH - row * vGapPt,
        w: cardW,
        h: cardH,
      });
    }
  }
  return { slots, capacity, cols: best.cols, rows: best.rows };
}

// Copies are no longer capped at what one sheet holds: fill a sheet, then spawn
// another and keep going from its top row. Every full sheet uses the same
// densest grid; only the last one is re-balanced for the leftover count.
function paginateLayout(copies: number, cardW: number, cardH: number, pw: number, ph: number) {
  const first = autoLayout(copies, cardW, cardH, pw, ph);
  const capacity = Math.max(1, first.capacity);
  const total = Math.max(1, copies);
  const pages: { x: number; y: number; w: number; h: number }[][] = [];
  let remaining = total;
  while (remaining > 0) {
    const count = Math.min(remaining, capacity);
    pages.push(autoLayout(count, cardW, cardH, pw, ph).slots);
    remaining -= count;
  }
  return { pages, capacity, cols: first.cols, rows: first.rows };
}

/**
 * Crop marks for one page: short lines in the margin that extend every card
 * edge, outside the card grid, so they never print over a neighbouring card.
 */
function cutMarkLines(draws: FaceDraw[]): { x1: number; y1: number; x2: number; y2: number }[] {
  if (draws.length === 0) return [];
  const left = Math.min(...draws.map((d) => d.x));
  const right = Math.max(...draws.map((d) => d.x + d.w));
  const bottom = Math.min(...draws.map((d) => d.y));
  const top = Math.max(...draws.map((d) => d.y + d.h));
  const xs = [...new Set(draws.flatMap((d) => [d.x, d.x + d.w]).map((v) => Math.round(v * 100) / 100))];
  const ys = [...new Set(draws.flatMap((d) => [d.y, d.y + d.h]).map((v) => Math.round(v * 100) / 100))];
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const x of xs) {
    lines.push({ x1: x, y1: top + CUT_MARK_OFFSET, x2: x, y2: top + CUT_MARK_OFFSET + CUT_MARK_LEN });
    lines.push({ x1: x, y1: bottom - CUT_MARK_OFFSET, x2: x, y2: bottom - CUT_MARK_OFFSET - CUT_MARK_LEN });
  }
  for (const y of ys) {
    lines.push({ x1: left - CUT_MARK_OFFSET, y1: y, x2: left - CUT_MARK_OFFSET - CUT_MARK_LEN, y2: y });
    lines.push({ x1: right + CUT_MARK_OFFSET, y1: y, x2: right + CUT_MARK_OFFSET + CUT_MARK_LEN, y2: y });
  }
  return lines;
}

// What survives an app restart (unless the shop turned Print Studio
// persistence off in Settings). Files are stored as-is (IndexedDB clones Blobs); previews and canvases
// are re-derived on restore.
interface CardSnapshot {
  frontFile: File | null;
  backFile: File | null;
  frontRot: number;
  backRot: number;
  multiCard: boolean;
  copies: number;
  duplex: boolean;
  colorMode: "color" | "bw";
  frontSourceJob: PrintJob | null;
  backSourceJob: PrintJob | null;
  sizeIdx?: number;
  paperIdx?: number;
  layoutMode?: LayoutMode;
  sets?: number;
  singleCopies?: number;
  fillCard?: boolean;
  cutMarks?: boolean;
}

const CardIDTool: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [frontDataUrl, setFrontDataUrl] = useState<string | null>(null);
  const [backDataUrl, setBackDataUrl] = useState<string | null>(null);
  const [frontRot, setFrontRot] = useState(0);
  const [backRot, setBackRot] = useState(0);
  // Faces waiting for the editor, head first. Uploads queue a perspective
  // crop; the Edit button queues a plain edit.
  const [editQueue, setEditQueue] = useState<{ face: Face; mode: "edit" | "perspective" }[]>([]);
  const [showJobLoader, setShowJobLoader] = useState(false);
  const [loadTarget, setLoadTarget] = useState<Face>("front");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showJobForm, setShowJobForm] = useState(false);
  const targets = useJobTargets();
  // Jobs the card faces were loaded from — offered for replacement by the
  // processed PDF when saving.
  const [frontSourceJob, setFrontSourceJob] = useState<PrintJob | null>(null);
  const [backSourceJob, setBackSourceJob] = useState<PrintJob | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("cards");
  const [multiCard, setMultiCard] = useState(false);
  // Cards per run in multi-card mode.
  const [copies, setCopies] = useState(4);
  // Printer copies of a single card sheet.
  const [singleCopies, setSingleCopies] = useState(1);
  // ID photocopy sets (front above back), packed several per sheet.
  const [sets, setSets] = useState(1);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [paperIdx, setPaperIdx] = useState(0);
  const [fillCard, setFillCard] = useState(false);
  const [cutMarks, setCutMarks] = useState(true);
  const [cropOnUpload, setCropOnUpload] = useState(readCropPref);
  // Card printing is duplex by default — front sheet + back sheet on the same
  // physical card. Kept togglable in case someone's printer can't duplex or
  // they're printing to two separate sheets.
  const [duplex, setDuplex] = useState(true);
  const [colorMode, setColorMode] = useState<"color" | "bw">("color");
  const [printing, setPrinting] = useState(false);
  const [defaultPrinter, setDefaultPrinter] = useState<string>("");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>({});
  const [dragFace, setDragFace] = useState<Face | null>(null);
  // False until the saved-across-restarts snapshot (if any) has been applied,
  // so the empty initial state never overwrites it.
  const [restored, setRestored] = useState(false);
  // Read on the first render: the handoff effect below clears these keys
  // before the async restore resolves, so checking them later is too late.
  const handoffPendingRef = useRef(
    !!(sessionStorage.getItem("ps_card_front") || sessionStorage.getItem("ps_card_back")),
  );

  useEffect(() => {
    if (!isElectron()) return;
    storageService.getSettings().then((s) => {
      setDefaultPrinter(s.defaultPrinterName || "");
      setPrinterDefaults(s.printerDefaults || {});
    }).catch(() => {});
  }, []);

  const PP_W = PAPER_SIZES[paperIdx]?.w ?? PAPER_SIZES[0].w;
  const PP_H = PAPER_SIZES[paperIdx]?.h ?? PAPER_SIZES[0].h;
  const PAD = 10 * MM_TO_PT;
  const card = CARD_SIZES[sizeIdx] ?? CARD_SIZES[0];
  const cardW = card.w * MM_TO_PT;
  const cardH = card.h * MM_TO_PT;
  const photocopy = layoutMode === "photocopy";
  const setGap = PHOTOCOPY_GAP_MM * MM_TO_PT;

  const cardLayout = useMemo(() => paginateLayout(copies, cardW, cardH, PP_W, PP_H), [copies, cardW, cardH, PP_W, PP_H]);
  const setLayout = useMemo(
    () => paginateLayout(sets, cardW, 2 * cardH + setGap, PP_W, PP_H),
    [sets, cardW, cardH, setGap, PP_W, PP_H],
  );

  /**
   * Every output sheet, as the pages it prints and the faces on each page.
   * Cards: a front page and a mirrored back page per sheet (F1,B1,F2,B2… so
   * duplex keeps each sheet's own back on its reverse). Photocopy: one page
   * per sheet with each set's front above its back.
   */
  const sheets = useMemo<FaceDraw[][][]>(() => {
    const hasFront = !!frontDataUrl;
    const hasBack = !!backDataUrl;
    if (photocopy) {
      return setLayout.pages.map((slots) => [
        slots.flatMap((s) => [
          ...(hasFront ? [{ face: "front" as const, x: s.x, y: s.y + cardH + setGap, w: cardW, h: cardH }] : []),
          ...(hasBack ? [{ face: "back" as const, x: s.x, y: hasFront ? s.y : s.y + cardH + setGap, w: cardW, h: cardH }] : []),
        ]),
      ]);
    }
    const sheetSlots = multiCard
      ? cardLayout.pages
      : [[{ x: PAD, y: PP_H - PAD - cardH, w: cardW, h: cardH }]];
    return sheetSlots.map((slots) => [
      ...(hasFront ? [slots.map((s) => ({ face: "front" as const, ...s }))] : []),
      // The back is mirrored left↔right so it lines up after a long-edge flip.
      ...(hasBack ? [slots.map((s) => ({ face: "back" as const, ...s, x: PP_W - s.x - s.w }))] : []),
    ]);
  }, [photocopy, setLayout, cardLayout, multiCard, frontDataUrl, backDataUrl, cardW, cardH, setGap, PAD, PP_W, PP_H]);

  const sheetCount = Math.max(1, sheets.length);
  const perSheet = photocopy ? setLayout.capacity : cardLayout.capacity;
  const layoutCols = photocopy ? setLayout.cols : cardLayout.cols;
  const layoutRows = photocopy ? setLayout.rows : cardLayout.rows;
  const drawCutMarks = cutMarks && (multiCard || photocopy);

  // Which sheet the preview shows; clamped whenever the count shrinks.
  const [sheetIdx, setSheetIdx] = useState(0);
  const activeSheet = Math.min(sheetIdx, sheetCount - 1);
  useEffect(() => {
    if (sheetIdx > sheetCount - 1) setSheetIdx(sheetCount - 1);
  }, [sheetIdx, sheetCount]);
  const pageCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Face images ready to draw: the original, or the centre-cropped version
  // when "fill the card" is on. Cached so a re-render never re-crops.
  const preparedCacheRef = useRef(new Map<string, Promise<string>>());
  const prepareFace = useCallback((face: Face): Promise<string> | null => {
    const dataUrl = face === "front" ? frontDataUrl : backDataUrl;
    const rot = face === "front" ? frontRot : backRot;
    if (!dataUrl) return null;
    if (!fillCard) return Promise.resolve(dataUrl);
    const key = `${cardW}x${cardH}|${rot}|${dataUrl}`;
    let p = preparedCacheRef.current.get(key);
    if (!p) {
      p = coverCropDataUrl(dataUrl, cardW, cardH, rot);
      if (preparedCacheRef.current.size > 8) preparedCacheRef.current.clear();
      preparedCacheRef.current.set(key, p);
    }
    return p;
  }, [frontDataUrl, backDataUrl, frontRot, backRot, fillCard, cardW, cardH]);

  const loadFace = useCallback(async (face: Face, f: File, opts: { crop: boolean; job?: PrintJob | null }) => {
    setExportError("");
    try {
      const urls = await readFileAsDataUrls(f);
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      const queue: { face: Face; mode: "perspective" }[] = [];
      if (face === "front") {
        setFrontFile(f);
        setFrontDataUrl(urls[0]);
        setFrontRot(0);
        setFrontSourceJob(opts.job ?? null);
        queue.push({ face: "front", mode: "perspective" });
        // A two-page PDF dropped on the front fills an empty back too.
        if (isPdf && urls[1] && !backDataUrl) {
          const backName = f.name.replace(/(\.pdf)?$/i, "-p2.png");
          setBackFile(new File([dataUrlToBlob(urls[1])], backName, { type: "image/png" }));
          setBackDataUrl(urls[1]);
          setBackRot(0);
          setBackSourceJob(opts.job ?? null);
          queue.push({ face: "back", mode: "perspective" });
          toast({ title: t("cardPdfBackFromPage2") });
        }
      } else {
        setBackFile(f);
        setBackDataUrl(urls[0]);
        setBackRot(0);
        setBackSourceJob(opts.job ?? null);
        queue.push({ face: "back", mode: "perspective" });
      }
      if (opts.crop) setEditQueue((prev) => [...prev, ...queue]);
    } catch (e) {
      const side = face === "front" ? t("frontImage") : t("backImage");
      setExportError(`${t("cardLoadFailed")} (${side}): ${errorMessage(e)}`);
    }
  }, [backDataUrl, t]);

  useStudioRestore<CardSnapshot>(
    "cards",
    async (snap) => {
      // An explicit "Print as Card" handoff wins over whatever was left from
      // the previous run.
      if (handoffPendingRef.current) return;
      if (snap.frontFile) {
        setFrontFile(snap.frontFile);
        setFrontDataUrl((await readFileAsDataUrls(snap.frontFile))[0]);
      }
      if (snap.backFile) {
        setBackFile(snap.backFile);
        setBackDataUrl((await readFileAsDataUrls(snap.backFile))[0]);
      }
      setFrontRot(snap.frontRot);
      setBackRot(snap.backRot);
      setMultiCard(snap.multiCard);
      setCopies(snap.copies);
      setDuplex(snap.duplex);
      setColorMode(snap.colorMode);
      setFrontSourceJob(snap.frontSourceJob ?? null);
      setBackSourceJob(snap.backSourceJob ?? null);
      if (snap.sizeIdx !== undefined && CARD_SIZES[snap.sizeIdx]) setSizeIdx(snap.sizeIdx);
      if (snap.paperIdx !== undefined && PAPER_SIZES[snap.paperIdx]) setPaperIdx(snap.paperIdx);
      if (snap.layoutMode) setLayoutMode(snap.layoutMode);
      if (snap.sets) setSets(snap.sets);
      if (snap.singleCopies) setSingleCopies(snap.singleCopies);
      if (snap.fillCard !== undefined) setFillCard(snap.fillCard);
      if (snap.cutMarks !== undefined) setCutMarks(snap.cutMarks);
    },
    () => setRestored(true),
  );

  useStudioSnapshot<CardSnapshot>(
    "cards",
    frontFile || backFile
      ? {
          frontFile,
          backFile,
          frontRot,
          backRot,
          multiCard,
          copies,
          duplex,
          colorMode,
          frontSourceJob,
          backSourceJob,
          sizeIdx,
          paperIdx,
          layoutMode,
          sets,
          singleCopies,
          fillCard,
          cutMarks,
        }
      : null,
    restored,
  );

  // ── Editor ────────────────────────────────────────────────────────────────
  const editing = editQueue[0] ?? null;
  const editingDataUrl = editing ? (editing.face === "front" ? frontDataUrl : backDataUrl) : null;
  const editingBlob = useMemo(
    () => (editingDataUrl?.startsWith("data:image") ? dataUrlToBlob(editingDataUrl) : null),
    [editingDataUrl],
  );
  // A face that was removed (or isn't an image) can't be edited — skip it.
  useEffect(() => {
    if (editing && !editingBlob) setEditQueue((q) => q.slice(1));
  }, [editing, editingBlob]);

  const openEditor = (face: Face) => setEditQueue((q) => [...q, { face, mode: "edit" }]);

  // Save the edited image straight back into the card face it came from and
  // re-render the preview — no re-upload needed.
  const handleEditedImageSave = useCallback(async (newBlob: Blob) => {
    const target = editQueue[0];
    setEditQueue((q) => q.slice(1));
    if (!target) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read edited image"));
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(newBlob);
      });
      const name = (target.face === "front" ? frontFile?.name : backFile?.name) || "edited-image.png";
      const file = new File([newBlob], name, { type: newBlob.type || "image/png" });
      if (target.face === "front") {
        setFrontFile(file);
        setFrontDataUrl(dataUrl);
      } else {
        setBackFile(file);
        setBackDataUrl(dataUrl);
      }
      toast({ title: isRtl ? "تم تحديث الصورة" : "Image updated", variant: "success" });
    } catch (e) {
      setExportError(`${t("cardLoadFailed")}: ${errorMessage(e)}`);
    }
  }, [editQueue, frontFile, backFile, isRtl, t]);

  // ── Preview ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const pagesOfSheet = sheets[activeSheet] ?? [];
    (async () => {
      const images: Partial<Record<Face, HTMLImageElement>> = {};
      for (const face of ["front", "back"] as Face[]) {
        const p = prepareFace(face);
        if (p) {
          try { images[face] = await loadImage(await p); } catch { /* drawn as an empty card */ }
        }
      }
      if (cancelled) return;
      pagesOfSheet.forEach((draws, i) => {
        const canvas = pageCanvasRefs.current[i];
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const pw = PP_W * SCALE;
        const ph = PP_H * SCALE;
        canvas.width = pw;
        canvas.height = ph;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pw, ph);
        ctx.strokeStyle = "#d1d5db";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, pw, ph);
        for (const d of draws) {
          const cw = d.w * SCALE;
          const ch = d.h * SCALE;
          const cx = d.x * SCALE;
          const cy = (PP_H - d.y - d.h) * SCALE;
          ctx.fillStyle = "#e5e7eb";
          ctx.fillRect(cx, cy, cw, ch);
          ctx.strokeStyle = "#9ca3af";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(cx, cy, cw, ch);
          const img = images[d.face];
          if (!img) continue;
          const rot = d.face === "front" ? frontRot : backRot;
          const rotated = rot % 180 !== 0;
          const fitted = containFitRotated(img.naturalWidth || cw, img.naturalHeight || ch, cw, ch, rotated);
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx, cy, cw, ch);
          ctx.clip();
          ctx.translate(cx + cw / 2, cy + ch / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(img, -fitted.w / 2, -fitted.h / 2, fitted.w, fitted.h);
          ctx.restore();
        }
        if (drawCutMarks) {
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 0.6;
          for (const l of cutMarkLines(draws)) {
            ctx.beginPath();
            ctx.moveTo(l.x1 * SCALE, (PP_H - l.y1) * SCALE);
            ctx.lineTo(l.x2 * SCALE, (PP_H - l.y2) * SCALE);
            ctx.stroke();
          }
        }
      });
    })();
    return () => { cancelled = true; };
  }, [sheets, activeSheet, prepareFace, frontRot, backRot, drawCutMarks, PP_W, PP_H]);

  // Auto-load front/back images from bulk "Print as Card" action
  useEffect(() => {
    const frontId = sessionStorage.getItem("ps_card_front");
    const backId = sessionStorage.getItem("ps_card_back");
    if (!frontId && !backId) return;
    sessionStorage.removeItem("ps_card_front");
    sessionStorage.removeItem("ps_card_back");
    (async () => {
      for (const [face, id] of [["front", frontId], ["back", backId]] as [Face, string | null][]) {
        if (!id) continue;
        try {
          const res = await fetch(`/api/files/public/${id}`);
          if (res.ok) {
            const blob = await res.blob();
            await loadFace(face, new File([blob], id, { type: blob.type || "image/png" }), { crop: false });
          }
        } catch { /* ignored */ }
      }
    })();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Output ────────────────────────────────────────────────────────────────
  const generatePdf = async (): Promise<Blob | null> => {
    if (!frontDataUrl && !backDataUrl) return null;
    setExportError("");
    setExporting(true);
    try {
      const pdfDoc = await PDFDocument.create();
      // Each face is embedded once and reused by every card on every sheet.
      const embedded: Partial<Record<Face, PDFImage>> = {};
      for (const face of ["front", "back"] as Face[]) {
        const p = prepareFace(face);
        if (p) embedded[face] = await embedImageInPdf(pdfDoc, await p);
      }
      for (const pagesOfSheet of sheets) {
        for (const draws of pagesOfSheet) {
          const page = pdfDoc.addPage([PP_W, PP_H]);
          for (const d of draws) {
            const img = embedded[d.face];
            if (!img) continue;
            const rot = d.face === "front" ? frontRot : backRot;
            const fitted = containFitRotated(img.width, img.height, d.w, d.h, rot % 180 !== 0);
            const o = rotatedImageOrigin(d, fitted.w, fitted.h, rot);
            page.drawImage(img, {
              x: o.x,
              y: o.y,
              width: fitted.w,
              height: fitted.h,
              rotate: degrees(o.rotate),
            });
          }
          if (drawCutMarks) {
            for (const l of cutMarkLines(draws)) {
              page.drawLine({ start: { x: l.x1, y: l.y1 }, end: { x: l.x2, y: l.y2 }, thickness: 0.5, color: rgb(0, 0, 0) });
            }
          }
        }
      }

      const pdfBytes = await pdfDoc.save();
      return new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
    } catch (e) {
      setExportError(`${t("cardExportFailed")}: ${errorMessage(e)}`);
      return null;
    } finally {
      setExporting(false);
    }
  };

  // Single cards get their copies from the printer; multi-card runs and
  // photocopy sets already hold every copy in the PDF.
  const printerCopies = !photocopy && !multiCard ? singleCopies : 1;

  const handleDownload = async () => {
    const blob = await generatePdf();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = photocopy ? "id-photocopy.pdf" : "id-card-duplex.pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = async () => {
    const blob = await generatePdf();
    if (!blob) return;
    // Browser fallback — no native bridge available.
    if (!isElectron()) {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      return;
    }
    setPrinting(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const printer = defaultPrinter;
      const saved = printer ? printerDefaults[printer] : undefined;
      // Duplex: user's toggle wins (never for a photocopy — both faces are on
      // the same side). Long-edge is the standard for card layouts where the
      // back is mirrored left↔right, so flipping along the long edge aligns them.
      // Color: pane toggle wins over the printer's saved default. `color: false`
      // is translated in electron/main.js into a CSS grayscale filter on the
      // hidden print window (Chromium's own color:false path prints solid
      // black on this driver stack).
      const options = {
        duplexMode: duplex && !photocopy ? "longEdge" : "simplex",
        color: colorMode !== "bw",
        copies: printerCopies,
        collate: saved?.collate ?? true,
        landscape: saved?.landscape ?? false,
      } as const;
      const result = await printData({
        data: bytes,
        fileType: "application/pdf",
        printerName: printer,
        // The spooler engine never shows UI; an empty printerName means the OS
        // default printer. See electron/print/spooler.js.
        silent: true,
        options,
      });
      if (result.cancelled) {
        toast({ title: isRtl ? "تم إلغاء الطباعة" : "Print cancelled" });
      } else if (result.ok) {
        toast({ title: isRtl ? "تم إرسال المهمة" : "Sent to printer", variant: "success" });
      }
    } catch (err) {
      toast({
        title: isRtl ? "فشل الطباعة" : "Print failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    } finally {
      setPrinting(false);
    }
  };

  const handleAddToJobs = async () => {
    // Only open the form if we actually have a fresh PDF — a failed
    // generatePdf() used to still open the form and let submitJob upload a
    // stale blob (or nothing).
    const blob = await generatePdf();
    if (!blob) return;
    await targets.refresh();
    // Pre-select the customer the faces came from, so "save it back onto that
    // job" is one click.
    targets.reset({ job: frontSourceJob || backSourceJob, selectJob: false });
    setShowJobForm(true);
  };

  const sourceJobIds = Array.from(
    new Set([frontSourceJob?.id, backSourceJob?.id].filter(Boolean) as string[]),
  );

  const submitJob = async () => {
    if (!targets.targetJob && !targets.name.trim()) return;
    setExportError("");
    try {
      // Regenerate from current state — the user may have changed size/color/
      // layout between opening the form and hitting "Add job".
      const blob = await generatePdf();
      if (!blob) return;
      setExporting(true);
      const file = new File([blob], photocopy ? "id-photocopy.pdf" : "id-cards.pdf", { type: "application/pdf" });
      const result = await targets.save({
        file,
        // Server/pricing expect "blackWhite"/"color", not this tool's "bw".
        preferences: {
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies: printerCopies,
          // A photocopy is an ordinary sheet; real cards go on card stock.
          paperType: photocopy ? "normal" : "cardboard",
        },
        pageCount: sheets.reduce((n, s) => n + s.length, 0),
        sourceJobIds,
        source: "card-tool",
      });
      if (result.replaced || targets.replaceSources) {
        setFrontSourceJob(null);
        setBackSourceJob(null);
      }
      setShowJobForm(false);
      toast({
        title: result.replaced
          ? isRtl ? "تم تحديث المهمة" : "Job updated"
          : isRtl ? "تمت إضافة المهمة" : "Job added",
        variant: "success",
      });
    } catch (e) {
      setExportError(errorMessage(e) || (isRtl ? "تعذّرت إضافة المهمة" : "Failed to add job"));
    } finally {
      setExporting(false);
    }
  };

  const jobLoaderSelect = (job: PrintJob, file: File | null) => {
    if (!file) return;
    void loadFace(loadTarget, file, { crop: false, job });
  };

  const removeFace = (face: Face) => {
    if (face === "front") {
      setFrontFile(null); setFrontDataUrl(null); setFrontRot(0); setFrontSourceJob(null);
    } else {
      setBackFile(null); setBackDataUrl(null); setBackRot(0); setBackSourceJob(null);
    }
  };

  const hasAny = !!(frontDataUrl || backDataUrl);

  const counter = (value: number, set: (n: number) => void, label: string, id: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" disabled={value <= 1} onClick={() => set(clampCopies(value - 1))} aria-label={isRtl ? "إنقاص" : "Decrease"}>
          <Icon name="minus" className="h-4 w-4" />
        </Button>
        <Input id={id} type="number" min={1} max={MAX_COPIES} className="text-center" value={value} onChange={(e) => set(clampCopies(Number(e.target.value)))} />
        <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" disabled={value >= MAX_COPIES} onClick={() => set(clampCopies(value + 1))} aria-label={isRtl ? "زيادة" : "Increase"}>
          <Icon name="plus" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  const toggleRow = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void, id: string) => (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-input px-3 py-2">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs font-medium cursor-pointer">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );

  const faceCard = (face: Face) => {
    const f = face === "front" ? frontFile : backFile;
    const url = face === "front" ? frontDataUrl : backDataUrl;
    const rot = face === "front" ? frontRot : backRot;
    const setRot = face === "front" ? setFrontRot : setBackRot;
    return (
      <Card className="shadow-none">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold">{face === "front" ? t("frontImage") : t("backImage")}</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!f ? (
            <div className="space-y-3">
              <label
                onDragOver={(e) => { e.preventDefault(); setDragFace(face); }}
                onDragLeave={() => setDragFace((cur) => (cur === face ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragFace(null);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) void loadFace(face, dropped, { crop: cropOnUpload });
                }}
                className={cn(
                  "flex flex-col items-center justify-center border-2 border-dashed border-input rounded-xl p-4 cursor-pointer hover:border-primary/50 transition",
                  dragFace === face && "border-primary bg-primary/5",
                )}
              >
                <Icon name="cloud-upload" className="w-6 h-6 text-muted-foreground mb-1" />
                <span className="text-xs text-muted-foreground">{face === "front" ? t("uploadFront") : t("uploadBack")}</span>
                <span className="text-xs text-muted-foreground/80">{t("cardDropHere")}</span>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    e.target.value = "";
                    if (picked) void loadFace(face, picked, { crop: cropOnUpload });
                  }}
                />
              </label>
              <Button variant="link" size="sm" className="w-full text-xs" onClick={() => { setLoadTarget(face); setShowJobLoader(true); }}>
                {t("loadFromJobs")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {url && <img src={url} alt="" className="h-9 w-14 shrink-0 rounded border object-cover bg-muted" />}
              <div className="flex-1 min-w-0 truncate text-sm" title={f.name}>{f.name}</div>
              <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" title={isRtl ? "تحرير الصورة" : "Edit image"} disabled={!url?.startsWith("data:image")} onClick={() => openEditor(face)}>
                {isRtl ? "تحرير" : "Edit"}
              </Button>
              <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs gap-1" title={isRtl ? "تدوير 90 درجة" : "Rotate 90°"} aria-label={isRtl ? "تدوير 90 درجة" : "Rotate 90°"} onClick={() => setRot((r) => (r + 90) % 360)}>
                <Icon name="rotate-cw" className="w-3.5 h-3.5" />
                {rot ? `${rot}°` : ""}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive h-auto px-2 py-1 text-xs" onClick={() => removeFace(face)}>
                {t("remove")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const pagesOfActiveSheet = sheets[activeSheet] ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-4">
        {faceCard("front")}
        {faceCard("back")}

        {toggleRow(t("cardCropOnUpload"), t("cardCropOnUploadHint"), cropOnUpload, (v) => { setCropOnUpload(v); writeCropPref(v); }, "card-crop-upload")}

        <Card className="shadow-none">
          <CardContent className="p-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cardLayoutMode")}</Label>
              <div className="grid grid-cols-2 gap-1">
                {([["cards", t("cardLayoutCards")], ["photocopy", t("cardLayoutPhotocopy")]] as [LayoutMode, string][]).map(([v, label]) => (
                  <Button key={v} type="button" size="sm" variant={layoutMode === v ? "default" : "outline"} className="h-8 text-xs" onClick={() => setLayoutMode(v)}>
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {photocopy ? t("cardLayoutPhotocopyHint") : t("cardLayoutCardsHint")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">{t("cardSize")}</Label>
                <Select value={String(sizeIdx)} onValueChange={(v) => setSizeIdx(Number(v))}>
                  <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CARD_SIZES.map((s, i) => <SelectItem key={s.label} value={String(i)}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("paperSize")}</Label>
                <Select value={String(paperIdx)} onValueChange={(v) => setPaperIdx(Number(v))}>
                  <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAPER_SIZES.map((s, i) => <SelectItem key={s.label} value={String(i)}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {!photocopy && toggleRow(
          isRtl ? "طباعة على الوجهين" : "Duplex printing",
          isRtl ? "الأمام والخلف على نفس البطاقة (افتراضي)" : "Front and back on the same card (default)",
          duplex, setDuplex, "card-duplex",
        )}

        {toggleRow(
          isRtl ? "أبيض وأسود" : "Black & white",
          isRtl ? "طباعة رمادية بدلاً من الألوان" : "Print grayscale instead of color",
          colorMode === "bw", (on) => setColorMode(on ? "bw" : "color"), "card-bw",
        )}

        {toggleRow(t("cardFillCard"), t("cardFillCardHint"), fillCard, setFillCard, "card-fill")}

        {!photocopy && toggleRow(
          isRtl ? "نسخ متعددة في نفس الورقة" : "Multiple copies per sheet",
          isRtl ? "طباعة عدة بطاقات على نفس الصفحة" : "Print several cards on one paper sheet",
          multiCard, setMultiCard, "card-multi",
        )}

        <div className="rounded-xl border border-input px-3 py-3 space-y-2">
          {photocopy
            ? counter(sets, setSets, t("cardSetsCount"), "card-sets")
            : multiCard
              ? counter(copies, setCopies, isRtl ? "عدد البطاقات" : "Number of cards", "card-copies")
              : counter(singleCopies, setSingleCopies, t("copies"), "card-single-copies")}
          {(photocopy || multiCard) && (
            <p className="text-xs text-muted-foreground">
              {isRtl
                ? `${perSheet} لكل ورقة (${layoutCols}×${layoutRows}) · ${sheetCount} ${sheetCount === 1 ? "ورقة" : "أوراق"}`
                : `${perSheet} per sheet (${layoutCols}×${layoutRows} layout) · ${sheetCount} sheet${sheetCount === 1 ? "" : "s"}`}
            </p>
          )}
        </div>

        {(photocopy || multiCard) && toggleRow(t("cardCutMarks"), t("cardCutMarksHint"), cutMarks, setCutMarks, "card-cut-marks")}

        {/* Same action order as the other studio tools: Print, save, download. */}
        <div className="space-y-2">
          <Button className="w-full gap-2" disabled={!hasAny || exporting || printing} onClick={handlePrint}>
            <Icon name="print" />
            {printing ? "..." : t("print")}
          </Button>
          {isElectron() && (
            <p className="text-xs text-muted-foreground text-center truncate" title={defaultPrinter}>
              {t("studioPrinterLabel")}: {defaultPrinter || t("studioSystemDefaultPrinter")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" disabled={!hasAny || exporting} variant="secondary" className="gap-1.5" onClick={handleAddToJobs}>
              <Icon name="save" />
              {t("addToJobs")}
            </Button>
            <Button size="sm" disabled={!hasAny || exporting} variant="outline" className="gap-1.5" onClick={handleDownload}>
              <Icon name="download" />
              {exporting ? "..." : t("download")}
            </Button>
          </div>
        </div>

        {exportError && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-xl p-3 border border-destructive/20">{exportError}</div>
        )}

        <Dialog open={showJobForm} onOpenChange={setShowJobForm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("addToJobsTitle")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pe-1">
              <JobTargetPicker
                targets={targets}
                isRtl={isRtl}
                sourceJobCount={sourceJobIds.length}
                sourceLabel={isRtl ? "صورة" : "source image(s)"}
              />
              {!targets.targetJob && (
                <div className="space-y-1.5">
                  <Label>{t("studioNotes")}</Label>
                  <Textarea value={targets.notes} onChange={(e) => targets.setNotes(e.target.value)} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowJobForm(false)}>{t("studioCancel")}</Button>
              <Button disabled={(!targets.targetJob && !targets.name.trim()) || exporting} onClick={submitJob}>
                {exporting
                  ? t("uploading")
                  : targets.targetJob
                    ? isRtl ? "استبدال الملف" : "Replace file"
                    : t("addJob")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="lg:col-span-2">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold">{t("preview")}</CardTitle>
              {sheetCount > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    disabled={activeSheet <= 0}
                    onClick={() => setSheetIdx(activeSheet - 1)}
                    aria-label={isRtl ? "الورقة السابقة" : "Previous sheet"}
                  >
                    <Icon name={isRtl ? "chevron-right" : "chevron-left"} className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {isRtl ? `ورقة ${activeSheet + 1}/${sheetCount}` : `Sheet ${activeSheet + 1}/${sheetCount}`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    disabled={activeSheet >= sheetCount - 1}
                    onClick={() => setSheetIdx(activeSheet + 1)}
                    aria-label={isRtl ? "الورقة التالية" : "Next sheet"}
                  >
                    <Icon name={isRtl ? "chevron-left" : "chevron-right"} className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {!hasAny ? (
              <div className="flex items-center justify-center h-[300px] bg-muted/30 rounded-xl text-muted-foreground text-sm">{t("noImages")}</div>
            ) : (
              <div className={cn("grid gap-4", pagesOfActiveSheet.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}>
                {pagesOfActiveSheet.map((draws, i) => (
                  <div key={i}>
                    <p className="text-xs font-medium text-muted-foreground mb-2 text-center">
                      {photocopy
                        ? t("cardLayoutPhotocopy")
                        : draws[0]?.face === "back" ? t("page2") : t("page1")}
                    </p>
                    <div className="flex justify-center">
                      <canvas
                        ref={(el) => { pageCanvasRefs.current[i] = el; }}
                        className="shadow-lg rounded-xl border max-w-full"
                        style={{ maxHeight: "60vh" }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 text-xs text-muted-foreground text-center">
              {card.label}
              {!photocopy && <> &middot; {t("page1Left")}</>}
            </div>
          </CardContent>
        </Card>
      </div>

      <LoadJobModal
        isOpen={showJobLoader}
        onClose={() => setShowJobLoader(false)}
        onSelect={jobLoaderSelect}
        filterType="image"
      />

      {editing && editingBlob && (
        <ImageEditor
          // Remount per queued face so each opens fresh in its own mode.
          key={`${editing.face}-${editQueue.length}`}
          imageBlob={editingBlob}
          lang={lang}
          initialMode={editing.mode}
          onSave={handleEditedImageSave}
          onCancel={() => setEditQueue((q) => q.slice(1))}
        />
      )}
    </div>
  );
};

export default CardIDTool;
