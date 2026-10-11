import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PDFDocument, PDFEmbeddedPage, PageSizes, degrees } from "pdf-lib";
import { getPdfjs, PDF_DOC_OPTIONS } from "../lib/pdfRender";
import { decodeImageToBitmap, canvasToImageBytes } from "../lib/imageNormalize";
import { nUpCells, parsePageRange, placePageInCell, sheetCount, sheetSizeFor, physicalSheets } from "../lib/pdfImpose";
import type { NUp, ScaleMode } from "../lib/pdfImpose";
import { buildZip } from "../lib/zip";
import LoadJobModal from "../components/LoadJobModal";
import { JobTargetPicker, useJobTargets } from "../components/JobTargetPicker";
import { useLanguage } from "../lib/useLanguage";
import { useStudioSnapshot, useStudioRestore, hasStudioSnapshot } from "../lib/studioPersist";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Switch } from "../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { cn } from "@atba3li/shared";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { isElectron, printData } from "../lib/electronPrint";
import type { PrintJob, PrinterJobDefaults } from "../types";
import { Icon } from "../components/ui/icon";
import { readPref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";

interface PageEntry {
  id: string;
  // Which loaded PDF this page comes from. Pages from several files live in
  // one list, which is what makes merging work.
  srcId: string;
  // Page index inside that source document.
  index: number;
  // Rotation the operator added, on top of the page's own /Rotate.
  rotation: number;
}

// One loaded document. `file` is what the operator gave us (a PDF or an
// image) and is what a snapshot stores; `bytes` is always a PDF — images and
// protected PDFs are converted on the way in. Pages are copied out of `bytes`
// lazily, at export/print time.
interface PdfSource {
  id: string;
  file: File;
  bytes: ArrayBuffer;
}

type PaperKey = "original" | "A4" | "A3" | "Letter" | "Legal";
type PageScope = "all" | "selected" | "range";

const PAPER_SIZES: { label: string; value: Exclude<PaperKey, "original"> }[] = [
  { label: "A4 (210×297mm)", value: "A4" },
  { label: "A3 (297×420mm)", value: "A3" },
  { label: "Letter (216×279mm)", value: "Letter" },
  { label: "Legal (216×356mm)", value: "Legal" },
];

const THUMB_W = 180;
const THUMB_H = 240;
const MM = 72 / 25.4;
// N-up sheets get a margin and gutter so no page lands in the printer's
// unprintable border; a 1-up sheet keeps the full paper, as before.
const NUP_MARGIN_PT = 5 * MM;
const NUP_GAP_PT = 4 * MM;
// Images dropped into the studio become pages at this resolution, capped to A4.
const IMAGE_PAGE_DPI = 150;
// Protected PDFs pdf-lib can't copy from are rasterised at this resolution.
const RASTER_DPI = 200;
const HISTORY_LIMIT = 50;

// sessionStorage key — restores a job-loaded PDF across refreshes so the
// user doesn't lose their in-progress layout every time Electron reloads.
const SESSION_KEY = "ps_pdfstudio_session_v1";

interface PersistedSession {
  sourceJobId: string;
  pages: PageEntry[];
  copies: number;
  colorMode: "color" | "bw";
  paperSize: string;
  duplex: boolean;
}

// What survives an app restart (unless the shop turned Print Studio
// persistence off in Settings). Unlike the sessionStorage session above this carries the PDFs themselves, so
// manually uploaded files come back too.
interface PdfSnapshot {
  // `files` is the current shape (one entry per merged source). `file` is the
  // pre-merge single-PDF shape, still read so older snapshots restore.
  files?: File[];
  file?: File;
  pages: PageEntry[];
  copies: number;
  colorMode: "color" | "bw";
  paperSize: string;
  duplex: boolean;
  sourceJob: PrintJob | null;
  nUp?: NUp;
  scaleMode?: ScaleMode;
}

function normRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

const thumbKey = (p: PageEntry) => `${p.srcId}:${p.index}:${normRotation(p.rotation)}`;

const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImageFile = (f: File) => f.type.startsWith("image/");

function toPaperKey(v: string | undefined): PaperKey {
  return v === "A4" || v === "A3" || v === "Letter" || v === "Legal" ? v : "original";
}

function baseName(name: string | undefined, fallback: string): string {
  return (name || fallback).replace(/\.[^.]+$/, "") || fallback;
}

/** pdf-lib load that tolerates owner-password ("protected") PDFs. */
function loadPdfLib(bytes: ArrayBuffer): Promise<PDFDocument> {
  return PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
}

/** Rebuild a PDF as one image per page, via pdf.js (which can decrypt). */
async function rasterizePdf(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const pdfjs = await getPdfjs();
  const src = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...PDF_DOC_OPTIONS }).promise;
  try {
    const out = await PDFDocument.create();
    for (let n = 1; n <= src.numPages; n++) {
      const page = await src.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RASTER_DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { bytes: img, type } = await canvasToImageBytes(canvas);
      const embedded = type === "image/jpeg" ? await out.embedJpg(img) : await out.embedPng(img);
      const p = out.addPage([base.width, base.height]);
      p.drawImage(embedded, { x: 0, y: 0, width: base.width, height: base.height });
    }
    const saved = await out.save();
    return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
  } finally {
    try { src.destroy(); } catch { /* noop */ }
  }
}

/** One-page PDF holding an image at IMAGE_PAGE_DPI, shrunk to fit A4 if larger. */
async function imageToPdf(file: File): Promise<ArrayBuffer> {
  const { bitmap, width, height } = await decodeImageToBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { bytes, type } = await canvasToImageBytes(canvas);
  const doc = await PDFDocument.create();
  const img = type === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  let w = (width * 72) / IMAGE_PAGE_DPI;
  let h = (height * 72) / IMAGE_PAGE_DPI;
  const [a4w, a4h] = w > h ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
  const shrink = Math.min(1, a4w / w, a4h / h);
  w *= shrink;
  h *= shrink;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  const saved = await doc.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

interface Ingested {
  src: PdfSource;
  pageCount: number;
  converted: boolean;
}

/** Turn a dropped/picked file into a PDF source, converting when needed. */
async function ingestFile(file: File): Promise<Ingested> {
  if (isImageFile(file)) {
    const bytes = await imageToPdf(file);
    const doc = await loadPdfLib(bytes);
    return { src: { id: crypto.randomUUID(), file, bytes }, pageCount: doc.getPageCount(), converted: false };
  }
  let bytes = await file.arrayBuffer();
  let doc = await loadPdfLib(bytes);
  let converted = false;
  // pdf-lib can read an encrypted file's structure but not decrypt its
  // content streams, so copied pages would come out blank or garbled.
  if (doc.isEncrypted) {
    bytes = await rasterizePdf(bytes);
    doc = await loadPdfLib(bytes);
    converted = true;
  }
  return { src: { id: crypto.randomUUID(), file, bytes }, pageCount: doc.getPageCount(), converted };
}

const PDFJobManager: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";

  const [sources, setSources] = useState<PdfSource[]>([]);
  const [pages, setPages] = useState<PageEntry[]>([]);
  // The first loaded PDF names the output and is the one a job save maps to.
  const file = sources[0]?.file ?? null;
  // Rendered thumbnails keyed by source page + rotation, so reorder/delete
  // never re-renders anything and a rotation renders only that page.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [sourceJob, setSourceJob] = useState<PrintJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<"color" | "bw">("color");
  const [paperSize, setPaperSize] = useState<PaperKey>("original");
  const [nUp, setNUp] = useState<NUp>(1);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  const [duplex, setDuplex] = useState(false);
  const [scope, setScope] = useState<PageScope>("all");
  const [rangeText, setRangeText] = useState("");
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showJobLoader, setShowJobLoader] = useState(false);
  // "replace" starts a fresh document, "add" merges the picked job's PDF into
  // the page list that is already open.
  const [jobLoaderMode, setJobLoaderMode] = useState<"replace" | "add">("replace");
  const [showNewJobDialog, setShowNewJobDialog] = useState(false);
  const [addJobUploading, setAddJobUploading] = useState(false);
  const targets = useJobTargets();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [defaultPrinter, setDefaultPrinter] = useState<string>("");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // False until the saved-across-restarts snapshot (if any) has been applied.
  const [restored, setRestored] = useState(false);
  // Read on the first render: the legacy session effect below clears this key
  // before the async restore resolves.
  const editHandoffRef = useRef(!!sessionStorage.getItem("ps_edit_job"));
  const rootRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<PageEntry[][]>([]);
  const anchorRef = useRef<string | null>(null);
  // One pdf.js document per source, shared by thumbnails, the enlarged
  // preview and image export.
  const pdfjsDocsRef = useRef(new Map<string, Promise<any>>());
  const renderingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isElectron()) return;
    storageService.getSettings().then((s) => {
      setDefaultPrinter(s.defaultPrinterName || "");
      setPrinterDefaults(s.printerDefaults || {});
    }).catch(() => {});
  }, []);

  // Refresh the customer/job list whenever the save dialog opens so the target
  // picker and the "previous files" list are current.
  const openNewJobDialog = async () => {
    await targets.refresh();
    // A PDF loaded from a job defaults to saving straight back onto that job.
    targets.reset({ job: sourceJob, selectJob: true });
    setShowNewJobDialog(true);
  };

  const tPages = t("studioPagesLabel");

  const pdfjsDocFor = useCallback(async (srcId: string): Promise<any | null> => {
    const cached = pdfjsDocsRef.current.get(srcId);
    if (cached) return cached;
    const src = sources.find((s) => s.id === srcId);
    if (!src) return null;
    const p = getPdfjs().then((pdfjsLib) =>
      pdfjsLib.getDocument({ data: new Uint8Array(src.bytes.slice(0)), ...PDF_DOC_OPTIONS }).promise,
    );
    pdfjsDocsRef.current.set(srcId, p);
    return p;
  }, [sources]);

  // Drop pdf.js documents whose source is gone; destroy all on unmount.
  useEffect(() => {
    const live = new Set(sources.map((s) => s.id));
    for (const [id, p] of pdfjsDocsRef.current) {
      if (!live.has(id)) {
        pdfjsDocsRef.current.delete(id);
        p.then((d) => d?.destroy?.()).catch(() => {});
      }
    }
  }, [sources]);
  useEffect(() => {
    const docs = pdfjsDocsRef.current;
    return () => {
      for (const p of docs.values()) p.then((d) => d?.destroy?.()).catch(() => {});
      docs.clear();
    };
  }, []);

  /** Render one source page with its own /Rotate plus the operator's rotation. */
  const renderPageToCanvas = useCallback(async (entry: PageEntry, maxW: number, maxH: number, cap: number) => {
    const pdf = await pdfjsDocFor(entry.srcId);
    if (!pdf) return null;
    const page = await pdf.getPage(entry.index + 1);
    // pdf.js replaces (not adds to) the page's own rotation when one is
    // passed, so combine them here.
    const rotation = normRotation((page.rotate || 0) + entry.rotation);
    const base = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(maxW / base.width, maxH / base.height, cap);
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }, [pdfjsDocFor]);

  // Render only the thumbnails we don't have yet.
  useEffect(() => {
    let cancelled = false;
    const missing = pages.filter((p) => !thumbnails[thumbKey(p)] && !renderingRef.current.has(thumbKey(p)));
    if (missing.length === 0) return;
    (async () => {
      for (const entry of missing) {
        if (cancelled) return;
        const key = thumbKey(entry);
        if (renderingRef.current.has(key)) continue;
        renderingRef.current.add(key);
        try {
          const canvas = await renderPageToCanvas(entry, THUMB_W * 1.5, THUMB_H * 1.5, 1);
          if (canvas) {
            const url = canvas.toDataURL("image/jpeg", 0.85);
            setThumbnails((prev) => ({ ...prev, [key]: url }));
          }
        } catch (err) {
          console.error(`Failed to render page ${entry.index + 1}:`, err);
        } finally {
          renderingRef.current.delete(key);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pages, thumbnails, renderPageToCanvas]);

  // Large preview for the page that was double-clicked.
  const previewEntry = previewId ? pages.find((p) => p.id === previewId) ?? null : null;
  useEffect(() => {
    setPreviewUrl(null);
    if (!previewEntry) return;
    let cancelled = false;
    renderPageToCanvas(previewEntry, 1100, 1400, 3)
      .then((c) => { if (!cancelled && c) setPreviewUrl(c.toDataURL("image/png")); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [previewEntry, renderPageToCanvas]);

  const pushHistory = useCallback(() => {
    historyRef.current.push(pages);
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
  }, [pages]);

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) {
      toast({ title: t("studioNothingToUndo") });
      return;
    }
    const ids = new Set(prev.map((p) => p.id));
    setPages(prev);
    setSelectedPages((sel) => new Set([...sel].filter((id) => ids.has(id))));
  }, [t]);

  const toastLoadError = useCallback((f: File, err: unknown) => {
    const msg = errorMessage(err);
    toast({
      title: t("studioPdfLoadFailed"),
      description: /password/i.test(msg)
        ? `${f.name}: ${isRtl ? "الملف محمي بكلمة مرور" : "the file is password-protected"}`
        : `${f.name}: ${msg}`,
      variant: "destructive",
    });
  }, [t, isRtl]);

  /** Ingest files, toasting failures; returns only what loaded. */
  const ingestAll = useCallback(async (files: File[]): Promise<Ingested[]> => {
    const accepted = files.filter((f) => isPdfFile(f) || isImageFile(f));
    if (accepted.length === 0) {
      toast({ title: t("studioNotAPdf"), variant: "destructive" });
      return [];
    }
    setLoading(true);
    const out: Ingested[] = [];
    try {
      for (const f of accepted) {
        try {
          const ing = await ingestFile(f);
          if (ing.converted) {
            toast({
              title: isRtl ? "ملف محمي" : "Protected PDF",
              description: isRtl
                ? `${f.name}: تم تحويله إلى صور ليمكن تعديله وطباعته`
                : `${f.name}: converted to images so it can be edited and printed`,
            });
          }
          out.push(ing);
        } catch (err) {
          toastLoadError(f, err);
        }
      }
    } finally {
      setLoading(false);
    }
    return out;
  }, [t, isRtl, toastLoadError]);

  /** Replace everything currently open with these files, in order. */
  const loadFiles = useCallback(async (files: File[], restoredPages?: PageEntry[]): Promise<boolean> => {
    const ingested = await ingestAll(files);
    if (ingested.length === 0) return false;
    const srcs = ingested.map((i) => i.src);
    const counts = ingested.map((i) => i.pageCount);
    let entries: PageEntry[];
    if (restoredPages && restoredPages.length > 0 && ingested.length === files.length) {
      // A restored list is positional: its srcId values are from the previous
      // session, so remap them onto the sources just rebuilt, in the same
      // order. Snapshots taken before merging existed carry no srcId at all
      // and land on the single source.
      const oldIds: string[] = [];
      for (const p of restoredPages) {
        const key = p.srcId ?? "";
        if (!oldIds.includes(key)) oldIds.push(key);
      }
      entries = restoredPages
        .map((p) => {
          const slot = Math.max(0, oldIds.indexOf(p.srcId ?? ""));
          const src = srcs[slot];
          return src && p.index < counts[slot] ? { ...p, srcId: src.id } : null;
        })
        .filter((p): p is PageEntry => p !== null);
    } else {
      entries = srcs.flatMap((src, i) =>
        Array.from({ length: counts[i] }, (_, p) => ({
          id: crypto.randomUUID(),
          srcId: src.id,
          index: p,
          rotation: 0,
        })),
      );
    }
    historyRef.current = [];
    setSources(srcs);
    setPages(entries);
    setSelectedPages(new Set());
    setThumbnails({});
    return true;
  }, [ingestAll]);

  const clearFile = () => {
    setSources([]);
    setPages([]);
    setThumbnails({});
    setSelectedPages(new Set());
    setSourceJob(null);
    historyRef.current = [];
    sessionStorage.removeItem(SESSION_KEY);
  };

  /** Merge: append these files' pages to the end of the current page list. */
  const appendFiles = useCallback(async (files: File[]) => {
    const ingested = await ingestAll(files);
    if (ingested.length === 0) return;
    const addedPages = ingested.flatMap(({ src, pageCount }) =>
      Array.from({ length: pageCount }, (_, i) => ({ id: crypto.randomUUID(), srcId: src.id, index: i, rotation: 0 })),
    );
    pushHistory();
    setSources((prev) => [...prev, ...ingested.map((i) => i.src)]);
    setPages((prev) => [...prev, ...addedPages]);
  }, [ingestAll, pushHistory]);

  /** Open these files: replace when nothing is loaded, merge otherwise. */
  const openOrAppend = (files: File[]) => {
    if (files.length === 0) return;
    if (sources.length > 0) {
      void appendFiles(files);
    } else {
      setSourceJob(null);
      void loadFiles(files);
    }
  };

  const handleLoadFromJob = async (job: PrintJob, f: File) => {
    if (!f || !isPdfFile(f)) return;
    if (await loadFiles([f])) setSourceJob(job);
  };

  /** Drop one merged source and every page that came from it. */
  const removeSource = (srcId: string) => {
    const remaining = sources.filter((s) => s.id !== srcId);
    if (remaining.length === 0) {
      clearFile();
      return;
    }
    // Undo can't bring the file back, so history that references it goes.
    historyRef.current = [];
    setSources(remaining);
    const dropped = new Set(pages.filter((p) => p.srcId === srcId).map((p) => p.id));
    setPages((prev) => prev.filter((p) => p.srcId !== srcId));
    setSelectedPages((prev) => new Set([...prev].filter((id) => !dropped.has(id))));
  };

  // On mount: restore a session (either from admin's "Edit" action, or
  // sessionStorage if we were mid-work before a refresh / lang toggle).
  useEffect(() => {
    const editJobId = sessionStorage.getItem("ps_edit_job");
    const savedRaw = sessionStorage.getItem(SESSION_KEY);
    // The studio snapshot carries the PDF bytes themselves and is restored by
    // the hook below — don't re-fetch the job on top of it.
    let superseded = false;
    const savedSession: PersistedSession | null = (() => {
      if (!savedRaw) return null;
      try { return JSON.parse(savedRaw) as PersistedSession; }
      catch { return null; }
    })();

    // Prefer an explicit "edit this job" over a stale session.
    const targetJobId = editJobId || savedSession?.sourceJobId;
    if (editJobId) sessionStorage.removeItem("ps_edit_job");
    if (!targetJobId) return;

    (async () => {
      try {
        if (!editJobId) {
          superseded = await hasStudioSnapshot("pdf");
          if (superseded) return;
        }
        const token = readPref("adminToken");
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/jobs", { headers });
        const jobs = await res.json();
        const job = Array.isArray(jobs) ? jobs.find((j: PrintJob) => j.id === targetJobId) : null;
        if (!job?.id) {
          sessionStorage.removeItem(SESSION_KEY);
          return;
        }
        const fileRes = await fetch(`/api/files/public/${job.id}`);
        if (!fileRes.ok) return;
        const blob = await fileRes.blob();
        const f = new File([blob], job.fileName, { type: job.fileType });
        if (!isPdfFile(f)) return;
        if (savedSession && savedSession.sourceJobId === targetJobId) {
          setCopies(savedSession.copies);
          setColorMode(savedSession.colorMode);
          setPaperSize(toPaperKey(savedSession.paperSize));
          setDuplex(savedSession.duplex);
        }
        if (await loadFiles([f], savedSession?.sourceJobId === targetJobId ? savedSession.pages : undefined)) {
          setSourceJob(job as PrintJob);
        }
      } catch (e) {
        console.error("Failed to restore PDF studio session:", e);
      }
    })();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useStudioRestore<PdfSnapshot>(
    "pdf",
    async (snap) => {
      // An explicit "edit this job" action wins over the previous state.
      if (editHandoffRef.current) return;
      const files = snap.files?.length ? snap.files : snap.file ? [snap.file] : [];
      if (files.length === 0) return;
      setSourceJob(snap.sourceJob ?? null);
      setCopies(snap.copies);
      setColorMode(snap.colorMode);
      setPaperSize(toPaperKey(snap.paperSize));
      setDuplex(snap.duplex);
      if (snap.nUp) setNUp(snap.nUp);
      if (snap.scaleMode) setScaleMode(snap.scaleMode);
      await loadFiles(files, snap.pages);
    },
    () => setRestored(true),
  );

  useStudioSnapshot<PdfSnapshot>(
    "pdf",
    sources.length > 0 && pages.length > 0
      ? { files: sources.map((s) => s.file), pages, copies, colorMode, paperSize, duplex, sourceJob, nUp, scaleMode }
      : null,
    restored,
  );

  // Persist just enough to restore a job-loaded PDF on refresh/lang change.
  useEffect(() => {
    // This session only re-fetches the source job's own PDF, so it can't
    // describe a merged document — the IndexedDB snapshot above covers that
    // case instead.
    if (!sourceJob || pages.length === 0 || sources.length !== 1) {
      sessionStorage.removeItem(SESSION_KEY);
      return;
    }
    const snapshot: PersistedSession = {
      sourceJobId: sourceJob.id,
      pages,
      copies,
      colorMode,
      paperSize,
      duplex,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
  }, [sourceJob, sources, pages, copies, colorMode, paperSize, duplex]);

  /** Click selects one; Ctrl/⌘ toggles; Shift extends from the last click. */
  const handlePageClick = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey && anchorRef.current) {
      const a = pages.findIndex((p) => p.id === anchorRef.current);
      const b = pages.findIndex((p) => p.id === id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedPages((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(pages[i].id);
          return next;
        });
        return;
      }
    }
    anchorRef.current = id;
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rotatePages = (ids: string[], deg: number) => {
    if (ids.length === 0) return;
    pushHistory();
    const idSet = new Set(ids);
    setPages((prev) =>
      prev.map((p) => (idSet.has(p.id) ? { ...p, rotation: normRotation(p.rotation + deg) } : p)),
    );
  };

  const deletePages = (ids: string[]) => {
    if (ids.length === 0) return;
    pushHistory();
    const idSet = new Set(ids);
    setPages((prev) => prev.filter((p) => !idSet.has(p.id)));
    setSelectedPages((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    toast({
      title: isRtl ? `تم حذف ${ids.length} صفحة` : `Deleted ${ids.length} page${ids.length === 1 ? "" : "s"}`,
      description: isRtl ? "Ctrl+Z للتراجع" : "Ctrl+Z to undo",
    });
  };

  const movePage = (fromId: string, toId: string) => {
    const fromIdx = pages.findIndex((p) => p.id === fromId);
    const toIdx = pages.findIndex((p) => p.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    pushHistory();
    const copy = [...pages];
    const [moved] = copy.splice(fromIdx, 1);
    copy.splice(toIdx, 0, moved);
    setPages(copy);
  };

  const selectAll = useCallback(() => {
    setSelectedPages((prev) => (prev.size === pages.length ? new Set() : new Set(pages.map((p) => p.id))));
  }, [pages]);

  // Keyboard shortcuts — only while this tool is the visible one and nothing
  // else (a dialog, a text field) owns the keyboard.
  const keyStateRef = useRef({ selectAll, undo, deletePages, selectedPages, pages });
  keyStateRef.current = { selectAll, undo, deletePages, selectedPages, pages };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const s = keyStateRef.current;
      if (s.pages.length === 0) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.selectAll();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        s.undo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedPages.size > 0) {
        e.preventDefault();
        s.deletePages([...s.selectedPages]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Output ────────────────────────────────────────────────────────────────

  // Which pages a print/export covers. null = the range text is invalid.
  const scopedPages = useMemo<PageEntry[] | null>(() => {
    if (scope === "selected") return pages.filter((p) => selectedPages.has(p.id));
    if (scope === "range") {
      const idx = parsePageRange(rangeText, pages.length);
      return idx ? idx.map((i) => pages[i]) : null;
    }
    return pages;
  }, [scope, pages, selectedPages, rangeText]);

  // N-up needs a real sheet, so "original" falls back to A4 there.
  const effectivePaper: PaperKey = paperSize === "original" && nUp > 1 ? "A4" : paperSize;
  const keepOriginal = effectivePaper === "original";

  const sidesFor = (count: number) => (keepOriginal ? count : sheetCount(count, nUp));

  /** Load each source document once, on demand, for a build pass. */
  const makeSourceLoader = () => {
    const loaded = new Map<string, Promise<PDFDocument>>();
    return (srcId: string): Promise<PDFDocument> => {
      const cached = loaded.get(srcId);
      if (cached) return cached;
      const src = sources.find((s) => s.id === srcId);
      if (!src) return Promise.reject(new Error("Missing source PDF"));
      const p = loadPdfLib(src.bytes).then((doc) => {
        // Embedding a page drops its form fields, so bake filled-in values
        // into the page first.
        try { doc.getForm().flatten(); } catch { /* no form, or one pdf-lib can't flatten */ }
        return doc;
      });
      loaded.set(srcId, p);
      return p;
    };
  };

  /**
   * Build the output PDF from `entries` with the current paper / pages-per-
   * sheet / scaling. `copies` are baked in; with duplex on, every copy is
   * padded to an even number of sides so the next copy starts on a fresh
   * sheet instead of the back of the last one.
   */
  const buildOutput = async (entries: PageEntry[], bakedCopies: number): Promise<Uint8Array> => {
    if (entries.length === 0) throw new Error(t("studioNothingToPrint"));
    const sourceFor = makeSourceLoader();
    const out = await PDFDocument.create();

    const appendOneCopy = async (embedCache: Map<string, PDFEmbeddedPage>): Promise<number> => {
      if (keepOriginal) {
        for (const entry of entries) {
          const src = await sourceFor(entry.srcId);
          const [copied] = await out.copyPages(src, [entry.index]);
          // Add to — not replace — the page's own /Rotate.
          copied.setRotation(degrees(normRotation(copied.getRotation().angle + entry.rotation)));
          out.addPage(copied);
        }
        return entries.length;
      }
      const paper = PageSizes[effectivePaper as keyof typeof PageSizes] as [number, number];
      const [sw, sh] = sheetSizeFor(paper, nUp);
      const margin = nUp > 1 ? NUP_MARGIN_PT : 0;
      const cells = nUpCells(sw - 2 * margin, sh - 2 * margin, nUp, nUp > 1 ? NUP_GAP_PT : 0).map((c) => ({
        ...c,
        x: c.x + margin,
        y: c.y + margin,
      }));
      let sides = 0;
      for (let i = 0; i < entries.length; i += nUp) {
        const sheet = out.addPage([sw, sh]);
        sides++;
        const chunk = entries.slice(i, i + nUp);
        for (let k = 0; k < chunk.length; k++) {
          const entry = chunk[k];
          const src = await sourceFor(entry.srcId);
          const srcPage = src.getPage(entry.index);
          const key = `${entry.srcId}:${entry.index}`;
          let embedded = embedCache.get(key);
          if (!embedded) {
            embedded = await out.embedPage(srcPage);
            embedCache.set(key, embedded);
          }
          const rot = normRotation(srcPage.getRotation().angle + entry.rotation);
          const place = placePageInCell(embedded.width, embedded.height, rot, cells[k], scaleMode);
          sheet.drawPage(embedded, {
            x: place.x,
            y: place.y,
            width: place.width,
            height: place.height,
            rotate: degrees(place.rotateCcw),
          });
        }
      }
      return sides;
    };

    const embedCache = new Map<string, PDFEmbeddedPage>();
    const n = Math.max(1, bakedCopies);
    for (let c = 0; c < n; c++) {
      const sides = await appendOneCopy(embedCache);
      if (duplex && n > 1 && c < n - 1 && sides % 2 === 1) {
        const last = out.getPage(out.getPageCount() - 1);
        out.addPage([last.getWidth(), last.getHeight()]);
      }
    }
    return out.save();
  };

  const guardScope = (): PageEntry[] | null => {
    if (scopedPages === null) {
      toast({ title: t("studioRangeInvalid"), variant: "destructive" });
      return null;
    }
    if (scopedPages.length === 0) {
      toast({ title: t("studioNothingToPrint"), variant: "destructive" });
      return null;
    }
    return scopedPages;
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportPDF = async () => {
    const entries = guardScope();
    if (!entries) return;
    setExporting(true);
    try {
      const bytes = await buildOutput(entries, copies);
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${baseName(file?.name, "print")}-ready.pdf`);
      toast({ title: t("studioExported"), variant: "success" });
    } catch (err) {
      toast({ title: t("studioExportFailed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const exportAsImages = async () => {
    const entries = guardScope();
    if (!entries) return;
    setExporting(true);
    try {
      const stem = baseName(file?.name, "page");
      const images: { name: string; data: Uint8Array }[] = [];
      for (let i = 0; i < entries.length; i++) {
        const canvas = await renderPageToCanvas(entries[i], 4000, 4000, 2);
        if (!canvas) continue;
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
        if (blob) images.push({ name: `${stem}_page_${i + 1}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (images.length === 1) {
        downloadBlob(new Blob([images[0].data as BlobPart], { type: "image/png" }), images[0].name);
      } else if (images.length > 1) {
        // One archive instead of one browser download prompt per page.
        downloadBlob(buildZip(images), `${stem}_pages.zip`);
      }
      toast({ title: t("studioExported"), variant: "success" });
    } catch (err) {
      toast({ title: t("studioExportFailed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const printDirectly = async () => {
    const entries = guardScope();
    if (!entries) return;
    setPrinting(true);
    try {
      // Duplex copies of an odd-sided document need a blank side between
      // them, which the driver won't add — bake those copies in ourselves.
      const bake = duplex && copies > 1 && sidesFor(entries.length) % 2 === 1;
      const output = await buildOutput(entries, bake ? copies : 1);
      // Browser fallback — no native bridge available.
      if (!isElectron()) {
        const blob = new Blob([output as BlobPart], { type: "application/pdf" });
        window.open(URL.createObjectURL(blob), "_blank");
        return;
      }
      const saved = defaultPrinter ? printerDefaults[defaultPrinter] : undefined;
      // The studio's own controls win over the printer's saved defaults —
      // copies/color/duplex are what the operator just set in this pane.
      // Duplex here means two-sided printing along the long edge, which is
      // what the "Duplex" toggle in the studio already implies.
      const options = {
        duplexMode: duplex ? "longEdge" : "simplex",
        color: colorMode !== "bw",
        copies: bake ? 1 : copies,
        collate: saved?.collate ?? true,
        landscape: saved?.landscape ?? false,
      } as const;
      const result = await printData({
        data: output,
        fileType: "application/pdf",
        printerName: defaultPrinter,
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

  // A saved job is the whole edited document — the page scope is a
  // print-time choice and never trims what gets stored.
  const buildForJob = () => buildOutput(pages, 1);

  const addToNewJob = async () => {
    if (!file || sources.length === 0) return;
    if (!targets.targetJob && !targets.name.trim()) return;
    setAddJobUploading(true);
    try {
      const output = await buildForJob();
      const blob = new Blob([output as BlobPart], { type: "application/pdf" });
      const outFile = new File([blob], `${baseName(file.name, "document")}.pdf`, { type: "application/pdf" });
      const result = await targets.save({
        file: outFile,
        preferences: {
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies,
          paperType: "normal",
        },
        pageCount: sidesFor(pages.length),
        sourceJobIds: sourceJob ? [sourceJob.id] : [],
      });
      if (result.replaced && result.jobId === sourceJob?.id) {
        // Saved back onto the same job — keep it as the session's source.
      } else if (sourceJob && result.removedIds.includes(sourceJob.id)) {
        setSourceJob(null);
      }
      setShowNewJobDialog(false);
      toast({
        title: result.replaced
          ? t("studioJobSaved")
          : t("studioJobCreated"),
        variant: "success",
      });
    } catch (err) {
      toast({ title: t("studioSaveFailed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setAddJobUploading(false);
    }
  };

  const saveToSourceJob = async () => {
    if (!sourceJob || !file || sources.length === 0) return;
    setSaving(true);
    try {
      const output = await buildForJob();
      const blob = new Blob([output as BlobPart], { type: "application/pdf" });
      const outFile = new File([blob], file.name, { type: "application/pdf" });
      await storageService.updateJobFile(sourceJob.id, outFile);
      await storageService.updateJobPreferences(sourceJob.id, {
        colorMode: colorMode === "bw" ? "blackWhite" : "color",
        copies,
        paperType: "normal",
      });
      toast({ title: t("studioJobSaved"), variant: "success" });
    } catch (err) {
      toast({ title: t("studioSaveFailed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const selectionSummary = t("studioSelectionSummary")
    .replace("{sel}", String(selectedPages.size))
    .replace("{total}", String(pages.length));

  const outSides = scopedPages ? sidesFor(scopedPages.length) : 0;
  const sheetsSummary = t("studioSheetsSummary")
    .replace("{sides}", String(outSides * copies))
    .replace("{sheets}", String(physicalSheets(outSides, copies, duplex)));

  // ── File drag-and-drop onto the whole tool ────────────────────────────────
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes("Files");
  const onRootDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!fileDragOver) setFileDragOver(true);
  };
  const onRootDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFileDragOver(false);
  };
  const onRootDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setFileDragOver(false);
    openOrAppend(Array.from(e.dataTransfer.files || []));
  };

  return (
    <div
      ref={rootRef}
      className="relative flex flex-col lg:flex-row gap-4"
      dir={isRtl ? "rtl" : "ltr"}
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
    >
      {fileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
          <div className="flex items-center gap-2 rounded-lg bg-background px-4 py-2 text-sm font-medium shadow">
            <Icon name="upload" className="w-4 h-4 text-primary" />
            {t("studioDropHere")}
          </div>
        </div>
      )}

      {/* Settings rail. On phones it sits *below* the page grid — otherwise the
          operator has to scroll past every settings card to see the PDF they
          just loaded. On desktop it sticks so Print stays reachable however far
          down the page grid is scrolled. */}
      <aside
        className={cn(
          "w-full lg:w-[280px] lg:shrink-0 lg:sticky lg:top-0 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-3",
          // Before a PDF is loaded the rail *is* the uploader, so it leads.
          pages.length > 0 && "order-2 lg:order-none",
        )}
      >
        {/* Source PDF */}
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm font-semibold">{t("sourcePDF")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {!file ? (
              <>
                <label className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-input bg-muted/30 py-6 px-4 cursor-pointer hover:border-primary/60 hover:bg-muted/50 transition-colors">
                  {loading ? (
                    <Icon name="spinner" className="w-7 h-7 text-muted-foreground mb-2 animate-spin" />
                  ) : (
                    <Icon name="upload" className="w-7 h-7 text-muted-foreground mb-2" />
                  )}
                  <span className="text-sm font-medium text-foreground text-center">{t("studioDropOrChoose")}</span>
                  <span className="text-xs text-muted-foreground mt-1">PDF · JPG · PNG</span>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      openOrAppend(picked);
                    }}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                  onClick={() => { setJobLoaderMode("replace"); setShowJobLoader(true); }}
                >
                  <Icon name="folder" />
                  {t("loadFromPrintJobs")}
                </Button>
              </>
            ) : (
              <div className="space-y-2">
                {/* One row per merged source. The first one carries the job
                    label, since that's the job a save writes back to. */}
                {sources.map((src, i) => (
                  <div key={src.id} className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-2.5">
                    <Icon name={isImageFile(src.file) ? "file-image" : "file-doc"} className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate" title={src.file.name}>
                        {sources.length > 1 && (
                          <span className="text-muted-foreground font-normal me-1">{i + 1}.</span>
                        )}
                        {src.file.name}
                      </div>
                      {i === 0 && sourceJob && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {t("studioFromJob")}: {sourceJob.customerName || (isRtl ? "بدون اسم" : "Unknown")}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => (sources.length > 1 ? removeSource(src.id) : clearFile())}
                      className="text-muted-foreground hover:text-destructive p-1 -m-1 shrink-0"
                      aria-label={sources.length > 1 ? t("studioRemoveFile") : t("remove")}
                      title={sources.length > 1 ? t("studioRemoveFile") : t("remove")}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                ))}

                {/* Merge — appends another PDF's pages to the same list. */}
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="inline-flex items-center justify-center gap-1.5 h-9 px-2 rounded-md border border-input bg-background text-xs font-medium cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors">
                    {loading ? <Icon name="spinner" className="w-3.5 h-3.5 animate-spin" /> : <Icon name="plus" className="w-3.5 h-3.5" />}
                    <span className="truncate">{t("studioAddPdf")}</span>
                    <input
                      type="file"
                      accept="application/pdf,image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        if (picked.length > 0) void appendFiles(picked);
                      }}
                    />
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 px-2 text-xs"
                    onClick={() => { setJobLoaderMode("add"); setShowJobLoader(true); }}
                  >
                    <Icon name="folder" className="w-3.5 h-3.5" />
                    <span className="truncate">{t("studioAddFromJobs")}</span>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {sources.length > 1
                    ? t("studioMergedFiles").replace("{n}", String(sources.length))
                    : t("studioMergeHint")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {pages.length > 0 && (
          <>
            {/* Tools — bulk operations */}
            <Card>
              <CardHeader className="p-4 pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold">{t("studioTools")}</CardTitle>
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {selectedPages.size === pages.length ? t("studioSelectNone") : t("studioSelectAll")}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{selectionSummary}</p>
              </CardHeader>
              <CardContent className="p-4 pt-0 space-y-2">
                <div className="grid grid-cols-3 gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], 90)}
                    title={t("studioRotate90CW")}
                  >
                    <Icon name="rotate-cw" className="w-3.5 h-3.5" />
                    <span className="text-xs">90°</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], -90)}
                    title={t("studioRotate90CCW")}
                  >
                    <Icon name="rotate-ccw" className="w-3.5 h-3.5" />
                    <span className="text-xs">-90°</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], 180)}
                    title={t("studioRotate180")}
                  >
                    <Icon name="flip" className="w-3.5 h-3.5" />
                    <span className="text-xs">180°</span>
                  </Button>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/5"
                    disabled={selectedPages.size === 0}
                    onClick={() => deletePages([...selectedPages])}
                  >
                    <Icon name="trash" />
                    {t("studioDelete")}
                    {selectedPages.size > 0 && ` (${selectedPages.size})`}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={undo}
                    title={`${t("studioUndo")} (Ctrl+Z)`}
                  >
                    <Icon name="rotate-ccw" className="w-3.5 h-3.5" />
                    {t("studioUndo")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{t("studioShortcutsHint")}</p>
              </CardContent>
            </Card>

            {/* Print options */}
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm font-semibold">{t("printOptions")}</CardTitle>
              </CardHeader>
              {/* One row shape for every setting — label on the start edge,
                  control on the end edge — so the different widgets read
                  as one list instead of unrelated blocks. */}
              <CardContent className="p-4 pt-0 divide-y divide-border">
                <div className="py-2.5 first:pt-0 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-xs font-medium text-muted-foreground">{t("studioPagesToPrint")}</Label>
                    <div className="grid grid-cols-3 gap-1 w-[160px] shrink-0">
                      {([
                        ["all", t("studioScopeAll")],
                        ["selected", `${t("studioScopeSelected")}${selectedPages.size ? ` ${selectedPages.size}` : ""}`],
                        ["range", t("studioScopeRange")],
                      ] as [PageScope, string][]).map(([v, label]) => (
                        <Button
                          key={v}
                          type="button"
                          size="sm"
                          variant={scope === v ? "default" : "outline"}
                          onClick={() => setScope(v)}
                          className="h-8 px-1 text-xs truncate"
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {scope === "range" && (
                    <div className="space-y-1">
                      <Input
                        value={rangeText}
                        onChange={(e) => setRangeText(e.target.value)}
                        placeholder={t("studioRangePlaceholder")}
                        dir="ltr"
                        className={cn("h-8 text-xs", rangeText.trim() && scopedPages === null && "border-destructive")}
                      />
                      {rangeText.trim() && scopedPages === null && (
                        <p className="text-xs text-destructive">{t("studioRangeInvalid")}</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 py-2.5">
                  <Label htmlFor="studio-copies" className="text-xs font-medium text-muted-foreground">
                    {t("copies")}
                  </Label>
                  <div className="flex items-center gap-1 w-[124px] shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={copies <= 1}
                      aria-label={isRtl ? "إنقاص عدد النسخ" : "Decrease copies"}
                      onClick={() => setCopies((c) => Math.max(1, c - 1))}
                    >
                      <Icon name="minus" />
                    </Button>
                    <Input
                      id="studio-copies"
                      type="number"
                      min={1}
                      max={999}
                      value={copies}
                      onChange={(e) => setCopies(Math.max(1, Math.min(999, parseInt(e.target.value) || 1)))}
                      className="h-8 min-w-0 text-center px-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={copies >= 999}
                      aria-label={isRtl ? "زيادة عدد النسخ" : "Increase copies"}
                      onClick={() => setCopies((c) => Math.min(999, c + 1))}
                    >
                      <Icon name="plus" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 py-2.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("colorMode")}</Label>
                  <div className="grid grid-cols-2 gap-1 w-[124px] shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant={colorMode === "color" ? "default" : "outline"}
                      onClick={() => setColorMode("color")}
                      className="h-8 px-1 text-xs"
                    >
                      {t("color")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={colorMode === "bw" ? "default" : "outline"}
                      onClick={() => setColorMode("bw")}
                      className="h-8 px-1 text-xs"
                    >
                      {t("bw")}
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 py-2.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("studioPaperSize")}</Label>
                  <Select value={paperSize} onValueChange={(v) => setPaperSize(toPaperKey(v))}>
                    <SelectTrigger className="h-8 w-[124px] shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="original">{t("studioPaperOriginal")}</SelectItem>
                      {PAPER_SIZES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-3 py-2.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("studioPagesPerSheet")}</Label>
                  <div className="grid grid-cols-3 gap-1 w-[124px] shrink-0">
                    {([1, 2, 4] as NUp[]).map((n) => (
                      <Button
                        key={n}
                        type="button"
                        size="sm"
                        variant={nUp === n ? "default" : "outline"}
                        onClick={() => setNUp(n)}
                        className="h-8 px-1 text-xs"
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                </div>

                {!keepOriginal && (
                  <div className="py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs font-medium text-muted-foreground">{t("studioScaleMode")}</Label>
                      <div className="grid grid-cols-2 gap-1 w-[124px] shrink-0">
                        {([
                          ["fit", t("studioScaleFit")],
                          ["actual", t("studioScaleActual")],
                        ] as [ScaleMode, string][]).map(([v, label]) => (
                          <Button
                            key={v}
                            type="button"
                            size="sm"
                            variant={scaleMode === v ? "default" : "outline"}
                            onClick={() => setScaleMode(v)}
                            className="h-8 px-1 text-xs"
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("studioScaleHint")}</p>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 py-2.5 last:pb-0">
                  <Label htmlFor="duplex-switch" className="text-xs font-medium text-muted-foreground cursor-pointer">
                    {t("studioDuplex")}
                  </Label>
                  <Switch id="duplex-switch" checked={duplex} onCheckedChange={setDuplex} />
                </div>
              </CardContent>
            </Card>

            {/* Actions are the end of the rail, not another settings card —
                dropping the card chrome lets Print read as the one thing that
                finishes the job. */}
            <div className="space-y-2 pt-1">
              <Button className="w-full gap-2" onClick={printDirectly} disabled={printing || scopedPages === null}>
                <Icon name="print" />
                {printing ? (isRtl ? "جارٍ الإرسال..." : "Sending...") : t("studioPrintDirect")}
              </Button>
              {isElectron() && (
                <p className="text-xs text-muted-foreground text-center truncate" title={defaultPrinter}>
                  {t("studioPrinterLabel")}: {defaultPrinter || t("studioSystemDefaultPrinter")}
                </p>
              )}
              {sourceJob && (
                <Button className="w-full gap-2" size="sm" variant="secondary" onClick={saveToSourceJob} disabled={saving}>
                  <Icon name="save" />
                  {saving ? t("uploading") : t("studioSaveToJob")}
                </Button>
              )}
              <Button
                className="w-full gap-2"
                size="sm"
                variant={sourceJob ? "outline" : "secondary"}
                onClick={openNewJobDialog}
              >
                <Icon name="plus" />
                {t("studioSaveAsNewJob")}
              </Button>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <Button variant="outline" size="sm" className="gap-1.5 px-1 text-xs" onClick={exportPDF} disabled={exporting}>
                  <Icon name="download" />
                  {exporting ? t("exporting") : t("studioExportPDF")}
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5 px-1 text-xs" onClick={exportAsImages} disabled={exporting}>
                  <Icon name="file-image" />
                  {exporting ? t("exporting") : t("studioExportImages")}
                </Button>
              </div>
            </div>
          </>
        )}
      </aside>

      {/* Main */}
      <section className={cn("flex-1 min-w-0", pages.length > 0 && "order-1 lg:order-none")}>
        <Card>
          <CardHeader className="p-4 pb-3 flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">
                {tPages}
                {pages.length > 0 && <span className="text-muted-foreground font-normal ms-1">({pages.length})</span>}
              </CardTitle>
              {pages.length > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">{sheetsSummary}</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {pages.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl bg-muted/30 border border-dashed border-border py-16 px-6 text-center">
                <div className="w-14 h-14 rounded-full bg-background border flex items-center justify-center mb-4">
                  <Icon name={loading ? "spinner" : "file-doc"} className={cn("w-6 h-6 text-muted-foreground", loading && "animate-spin")} />
                </div>
                <p className="text-sm font-medium text-foreground">{t("studioNoPdfYet")}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t("studioNoPdfHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                {pages.map((entry, idx) => {
                  const thumb = thumbnails[thumbKey(entry)];
                  return (
                    <div key={entry.id} className="group">
                      <div
                        role="button"
                        tabIndex={0}
                        aria-pressed={selectedPages.has(entry.id)}
                        draggable
                        onDragStart={(e) => {
                          setDragId(entry.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          if (!dragId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (dropTargetId !== entry.id) setDropTargetId(entry.id);
                        }}
                        onDrop={(e) => {
                          if (!dragId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          movePage(dragId, entry.id);
                          setDragId(null);
                          setDropTargetId(null);
                        }}
                        onDragEnd={() => { setDragId(null); setDropTargetId(null); }}
                        onClick={(e) => handlePageClick(entry.id, e)}
                        onDoubleClick={() => setPreviewId(entry.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handlePageClick(entry.id, e);
                          }
                        }}
                        className={cn(
                          "relative rounded-lg border bg-background overflow-hidden cursor-pointer transition-all",
                          "hover:border-primary/40 hover:shadow-sm",
                          selectedPages.has(entry.id) && "border-primary ring-2 ring-primary/25",
                          dragId === entry.id && "opacity-40",
                          dropTargetId === entry.id && dragId !== entry.id && "ring-2 ring-primary ring-offset-2",
                        )}
                      >
                        <div className="flex items-center justify-center bg-muted/40 p-2" style={{ height: THUMB_H }}>
                          {thumb ? (
                            <img
                              src={thumb}
                              alt={`${tPages} ${idx + 1}`}
                              draggable={false}
                              className="max-w-full max-h-full object-contain rounded-sm shadow-sm bg-white"
                            />
                          ) : (
                            <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                              <Icon name="spinner" className="w-6 h-6 animate-spin" />
                              <span className="text-xs">{t("studioLoadingThumb")}</span>
                            </div>
                          )}
                        </div>

                        {/* Page number */}
                        <div className="absolute bottom-1.5 end-1.5 bg-background/90 backdrop-blur border text-foreground text-xs font-semibold px-1.5 py-0.5 rounded">
                          {idx + 1}
                        </div>

                        {/* Rotation badge */}
                        {entry.rotation !== 0 && (
                          <div className="absolute top-1.5 start-1.5 bg-primary text-primary-foreground text-xs font-semibold px-1.5 py-0.5 rounded">
                            {entry.rotation}°
                          </div>
                        )}

                        {/* Which merged file this page came from — only worth
                            showing once more than one file is loaded. */}
                        {sources.length > 1 && (
                          <div
                            className="absolute bottom-1.5 start-1.5 bg-background/90 backdrop-blur border text-muted-foreground text-xs font-medium px-1.5 py-0.5 rounded max-w-[70%] truncate"
                            title={sources.find((s) => s.id === entry.srcId)?.file.name}
                          >
                            {sources.findIndex((s) => s.id === entry.srcId) + 1}
                          </div>
                        )}

                        {/* Quick actions — always shown on touch screens,
                            on hover/focus elsewhere. */}
                        <div className="absolute top-1.5 end-1.5 flex gap-1 opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setPreviewId(entry.id); }}
                            className="bg-background/90 backdrop-blur border hover:bg-background text-foreground rounded p-1 shadow-sm"
                            title={t("studioEnlarge")}
                            aria-label={t("studioEnlarge")}
                          >
                            <Icon name="search" className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); rotatePages([entry.id], 90); }}
                            className="bg-background/90 backdrop-blur border hover:bg-background text-foreground rounded p-1 shadow-sm"
                            title={t("studioRotate90CW")}
                            aria-label={t("studioRotate90CW")}
                          >
                            <Icon name="rotate-cw" className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); deletePages([entry.id]); }}
                            className="bg-background/90 backdrop-blur border hover:bg-destructive hover:text-destructive-foreground text-destructive rounded p-1 shadow-sm"
                            title={t("studioDelete")}
                            aria-label={t("studioDelete")}
                          >
                            <Icon name="x" className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <LoadJobModal
        isOpen={showJobLoader}
        onClose={() => setShowJobLoader(false)}
        onSelect={(job, f) => {
          if (!f) return;
          if (jobLoaderMode === "add" && sources.length > 0) void appendFiles([f]);
          else void handleLoadFromJob(job, f);
        }}
        filterType="pdf"
      />

      {/* Enlarged page */}
      <Dialog open={!!previewEntry} onOpenChange={(open) => { if (!open) setPreviewId(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {tPages} {previewEntry ? pages.indexOf(previewEntry) + 1 : ""} / {pages.length}
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center bg-muted/40 rounded-lg p-2 min-h-[50vh] max-h-[75vh] overflow-auto">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="max-w-full max-h-[72vh] object-contain bg-white shadow" />
            ) : (
              <Icon name="spinner" className="w-7 h-7 animate-spin text-muted-foreground" />
            )}
          </div>
          {previewEntry && (
            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={pages.indexOf(previewEntry) <= 0}
                  onClick={() => setPreviewId(pages[pages.indexOf(previewEntry) - 1]?.id ?? null)}
                  aria-label={isRtl ? "السابقة" : "Previous"}
                >
                  <Icon name={isRtl ? "chevron-right" : "chevron-left"} />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={pages.indexOf(previewEntry) >= pages.length - 1}
                  onClick={() => setPreviewId(pages[pages.indexOf(previewEntry) + 1]?.id ?? null)}
                  aria-label={isRtl ? "التالية" : "Next"}
                >
                  <Icon name={isRtl ? "chevron-left" : "chevron-right"} />
                </Button>
              </div>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => rotatePages([previewEntry.id], -90)}>
                  <Icon name="rotate-ccw" className="w-3.5 h-3.5" /> -90°
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => rotatePages([previewEntry.id], 90)}>
                  <Icon name="rotate-cw" className="w-3.5 h-3.5" /> 90°
                </Button>
              </div>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showNewJobDialog} onOpenChange={setShowNewJobDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("studioNewJobTitle")}</DialogTitle>
            <DialogDescription>{t("studioNewJobDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-[65vh] overflow-y-auto pe-1">
            <JobTargetPicker
              targets={targets}
              isRtl={isRtl}
              sourceJobCount={sourceJob ? 1 : 0}
              sourceLabel={isRtl ? "المهمة المصدر" : "source job"}
            />
            {!targets.targetJob && (
              <div className="space-y-1.5">
                <Label>{t("studioNotes")}</Label>
                <Input value={targets.notes} onChange={(e) => targets.setNotes(e.target.value)} placeholder={t("studioNotes")} />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowNewJobDialog(false)}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button
              onClick={addToNewJob}
              disabled={addJobUploading || (!targets.targetJob && !targets.name.trim())}
            >
              {addJobUploading
                ? t("uploading")
                : targets.targetJob
                  ? isRtl ? "استبدال الملف" : "Replace file"
                  : targets.removeJobIds.size > 0 || targets.replaceSources
                    ? isRtl ? "حفظ واستبدال" : "Save & Replace"
                    : t("studioCreate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PDFJobManager;
