import React, { useState, useRef, useEffect, useCallback } from "react";
import { PDFDocument, PDFEmbeddedPage, PageSizes, degrees } from "pdf-lib";
import { getPdfjs, PDF_DOC_OPTIONS } from "../lib/pdfRender";
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
  rotation: number;
}

// One loaded PDF. The studio keeps the bytes of every source around because
// pages are copied out of them lazily, at export/print time.
interface PdfSource {
  id: string;
  file: File;
  bytes: ArrayBuffer;
}

const PAPER_SIZES = [
  { label: "A4 (210×297mm)", value: "A4" },
  { label: "A3 (297×420mm)", value: "A3" },
  { label: "Letter (216×279mm)", value: "Letter" },
  { label: "Legal (216×356mm)", value: "Legal" },
] as const;

const THUMB_W = 180;
const THUMB_H = 240;

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
}

function normRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}



const PDFJobManager: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";

  const [sources, setSources] = useState<PdfSource[]>([]);
  const [pages, setPages] = useState<PageEntry[]>([]);
  // The first loaded PDF names the output and is the one a job save maps to.
  const file = sources[0]?.file ?? null;
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [sourceJob, setSourceJob] = useState<PrintJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<"color" | "bw">("color");
  const [paperSize, setPaperSize] = useState("A4");
  const [duplex, setDuplex] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showJobLoader, setShowJobLoader] = useState(false);
  // "replace" starts a fresh document, "add" merges the picked job's PDF into
  // the page list that is already open.
  const [jobLoaderMode, setJobLoaderMode] = useState<"replace" | "add">("replace");
  const [showNewJobDialog, setShowNewJobDialog] = useState(false);
  const [addJobUploading, setAddJobUploading] = useState(false);
  const targets = useJobTargets();
  const [dragId, setDragId] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [defaultPrinter, setDefaultPrinter] = useState<string>("");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>({});
  // False until the saved-across-restarts snapshot (if any) has been applied.
  const [restored, setRestored] = useState(false);
  // Read on the first render: the legacy session effect below clears this key
  // before the async restore resolves.
  const editHandoffRef = useRef(!!sessionStorage.getItem("ps_edit_job"));

  useEffect(() => {
    if (!isElectron()) return;
    storageService.getSettings().then((s) => {
      setDefaultPrinter(s.defaultPrinterName || "");
      setPrinterDefaults(s.printerDefaults || {});
    }).catch(() => {});
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  // Refresh the customer/job list whenever the save dialog opens so the target
  // picker and the "previous files" list are current.
  const openNewJobDialog = async () => {
    await targets.refresh();
    // A PDF loaded from a job defaults to saving straight back onto that job.
    targets.reset({ job: sourceJob, selectJob: true });
    setShowNewJobDialog(true);
  };

  const tPages = t("studioPagesLabel");

  const renderThumbnails = useCallback(async (srcs: PdfSource[], pageEntries: PageEntry[]) => {
    try {
      const pdfjsLib = await getPdfjs();
      // One pdf.js document per source, opened lazily and shared by every page
      // that comes from it.
      const docs = new Map<string, any>();
      const docFor = async (srcId: string) => {
        const cached = docs.get(srcId);
        if (cached) return cached;
        const src = srcs.find((s) => s.id === srcId);
        if (!src) return null;
        const doc = await pdfjsLib.getDocument({ data: src.bytes.slice(0), ...PDF_DOC_OPTIONS }).promise;
        docs.set(srcId, doc);
        return doc;
      };
      const results: Record<string, string> = {};
      for (const entry of pageEntries) {
        try {
          const pdf = await docFor(entry.srcId);
          if (!pdf) continue;
          const page = await pdf.getPage(entry.index + 1);
          // Rotation must live on the viewport — pdf.js's RenderParameters
          // has no top-level `rotation` field, so passing it there was a no-op.
          const base = page.getViewport({ scale: 1, rotation: entry.rotation });
          const scale = Math.min(THUMB_W / base.width, THUMB_H / base.height, 0.6);
          const scaled = page.getViewport({ scale, rotation: entry.rotation });
          const canvas = document.createElement("canvas");
          canvas.width = scaled.width;
          canvas.height = scaled.height;
          const ctx = canvas.getContext("2d")!;
          await page.render({ canvasContext: ctx, viewport: scaled }).promise;
          results[entry.id] = canvas.toDataURL("image/png");
        } catch (pageErr) {
          console.error(`Failed to render page ${entry.index + 1}:`, pageErr);
        }
      }
      setThumbnails((prev) => ({ ...prev, ...results }));
      for (const doc of docs.values()) {
        try { doc.destroy(); } catch { /* noop */ }
      }
    } catch (err) {
      console.error("pdf.js failed to open document:", err);
      toast({
        title: isRtl ? "تعذر عرض المعاينات" : "Could not render previews",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }, [isRtl]);

  /** Replace everything currently open with these files, in order. */
  const loadPdfs = useCallback(async (
    files: File[],
    buffers: ArrayBuffer[],
    restoredPages?: PageEntry[],
  ) => {
    const srcs: PdfSource[] = [];
    const counts: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const pdf = await PDFDocument.load(buffers[i]);
      srcs.push({ id: crypto.randomUUID(), file: files[i], bytes: buffers[i] });
      counts.push(pdf.getPageCount());
    }
    let entries: PageEntry[];
    if (restoredPages && restoredPages.length > 0) {
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
    setSources(srcs);
    setPages(entries);
    setSelectedPages(new Set());
    setThumbnails({});
    renderThumbnails(srcs, entries);
  }, [renderThumbnails]);

  const loadPdf = useCallback(
    (f: File, buf: ArrayBuffer, restoredPages?: PageEntry[]) =>
      loadPdfs([f], [buf], restoredPages),
    [loadPdfs],
  );

  const clearFile = () => {
    setSources([]);
    setPages([]);
    setThumbnails({});
    setSelectedPages(new Set());
    setSourceJob(null);
    sessionStorage.removeItem(SESSION_KEY);
  };

  /** Merge: append these PDFs' pages to the end of the current page list. */
  const appendPdfs = useCallback(async (files: File[]) => {
    const pdfFiles = files.filter((f) => f.type === "application/pdf");
    if (pdfFiles.length === 0) {
      toast({ title: t("studioNotAPdf"), variant: "destructive" });
      return;
    }
    const added: PdfSource[] = [];
    const addedPages: PageEntry[] = [];
    for (const f of pdfFiles) {
      try {
        const buf = await f.arrayBuffer();
        const pdf = await PDFDocument.load(buf);
        const src: PdfSource = { id: crypto.randomUUID(), file: f, bytes: buf };
        added.push(src);
        for (let i = 0; i < pdf.getPageCount(); i++) {
          addedPages.push({ id: crypto.randomUUID(), srcId: src.id, index: i, rotation: 0 });
        }
      } catch (err) {
        toast({
          title: t("studioNotAPdf"),
          description: `${f.name}: ${errorMessage(err)}`,
          variant: "destructive",
        });
      }
    }
    if (added.length === 0) return;
    // Thumbnails follow from the effect that watches `sources`/`pages`.
    setSources((prev) => [...prev, ...added]);
    setPages((prev) => [...prev, ...addedPages]);
  }, [t]);

  const handleFile = async (f: File | null | undefined) => {
    if (!f || f.type !== "application/pdf") return;
    setSourceJob(null);
    const buf = await f.arrayBuffer();
    await loadPdf(f, buf);
  };

  const handleLoadFromJob = async (job: PrintJob, f: File) => {
    if (!f || f.type !== "application/pdf") return;
    setSourceJob(job);
    const buf = await f.arrayBuffer();
    await loadPdf(f, buf);
  };

  /** Drop one merged source and every page that came from it. */
  const removeSource = (srcId: string) => {
    const remaining = sources.filter((s) => s.id !== srcId);
    if (remaining.length === 0) {
      clearFile();
      return;
    }
    setSources(remaining);
    const dropped = new Set(pages.filter((p) => p.srcId === srcId).map((p) => p.id));
    setPages((prev) => prev.filter((p) => p.srcId !== srcId));
    setSelectedPages((prev) => new Set([...prev].filter((id) => !dropped.has(id))));
  };

  // Re-render thumbnails on rotation / reorder — `sources` stays stable so the
  // dep set is intentionally narrow (avoids the `renderThumbnails` dep loop
  // the previous version had).
  useEffect(() => {
    if (sources.length > 0 && pages.length > 0) {
      renderThumbnails(sources, pages);
    }
  }, [pages, sources, renderThumbnails]);

  // On mount: restore a session (either from admin's "Edit" action, or
  // sessionStorage if we were mid-work before a refresh / lang toggle).
  useEffect(() => {
    const editJobId = sessionStorage.getItem("ps_edit_job");
    const savedRaw = sessionStorage.getItem(SESSION_KEY);
    // The studio snapshot carries the PDF bytes themselves and is restored by
    // the hook above — don't re-fetch the job on top of it.
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
        if (f.type !== "application/pdf") return;
        setSourceJob(job as PrintJob);
        if (savedSession && savedSession.sourceJobId === targetJobId) {
          setCopies(savedSession.copies);
          setColorMode(savedSession.colorMode);
          setPaperSize(savedSession.paperSize);
          setDuplex(savedSession.duplex);
        }
        const buf = await f.arrayBuffer();
        await loadPdf(f, buf, savedSession?.sourceJobId === targetJobId ? savedSession.pages : undefined);
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
      setPaperSize(snap.paperSize);
      setDuplex(snap.duplex);
      const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
      await loadPdfs(files, buffers, snap.pages);
    },
    () => setRestored(true),
  );

  useStudioSnapshot<PdfSnapshot>(
    "pdf",
    sources.length > 0 && pages.length > 0
      ? { files: sources.map((s) => s.file), pages, copies, colorMode, paperSize, duplex, sourceJob }
      : null,
    restored,
  );

  // Persist just enough to restore a job-loaded PDF on refresh/lang change.
  // Manually uploaded PDFs aren't persisted (would need IndexedDB for the
  // bytes) — clearing here also handles the "user removed the file" case.
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

  const toggleSelect = (id: string) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rotatePages = (ids: string[], deg: number) => {
    setPages((prev) =>
      prev.map((p) =>
        ids.includes(p.id) ? { ...p, rotation: normRotation(p.rotation + deg) } : p,
      ),
    );
  };

  const deletePages = (ids: string[]) => {
    const idSet = new Set(ids);
    setPages((prev) => prev.filter((p) => !idSet.has(p.id)));
    setSelectedPages((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const movePage = (fromId: string, toId: string) => {
    setPages((prev) => {
      const copy = [...prev];
      const fromIdx = copy.findIndex((p) => p.id === fromId);
      const toIdx = copy.findIndex((p) => p.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    });
  };

  /** Load each source document once, on demand, for a build pass. */
  const makeSourceLoader = () => {
    const loaded = new Map<string, Promise<PDFDocument>>();
    return (srcId: string): Promise<PDFDocument> => {
      const cached = loaded.get(srcId);
      if (cached) return cached;
      const src = sources.find((s) => s.id === srcId);
      if (!src) return Promise.reject(new Error("Missing source PDF"));
      const p = PDFDocument.load(src.bytes.slice(0));
      loaded.set(srcId, p);
      return p;
    };
  };

  const buildPdfFromPages = async (): Promise<Uint8Array> => {
    if (sources.length === 0) throw new Error("No PDF loaded");
    const sourceFor = makeSourceLoader();
    const newDoc = await PDFDocument.create();
    for (const entry of pages) {
      const sourcePdf = await sourceFor(entry.srcId);
      const [copiedPage] = await newDoc.copyPages(sourcePdf, [entry.index]);
      const rot = normRotation(entry.rotation);
      if (rot !== 0) copiedPage.setRotation(degrees(rot));
      newDoc.addPage(copiedPage);
    }
    return newDoc.save();
  };

  const getExportPageCount = (): number => {
    if (duplex) return Math.ceil((pages.length * copies) / 2) * 2;
    return pages.length * copies;
  };

  const exportPDF = async () => {
    if (sources.length === 0) return;
    setExporting(true);
    try {
      const sourceFor = makeSourceLoader();
      const newDoc = await PDFDocument.create();
      const sizeKey = paperSize as keyof typeof PageSizes;
      const targetSize = PageSizes[sizeKey] || PageSizes.A4;

      for (let c = 0; c < copies; c++) {
        for (const entry of pages) {
          const sourcePdf = await sourceFor(entry.srcId);
          const [copiedPage] = await newDoc.copyPages(sourcePdf, [entry.index]);
          const rot = normRotation(entry.rotation);
          if (rot !== 0) copiedPage.setRotation(degrees(rot));
          const [pw, ph] = targetSize;
          const page = newDoc.addPage(targetSize);
          const scale = Math.min(pw / copiedPage.getWidth(), ph / copiedPage.getHeight());
          const sw = copiedPage.getWidth() * scale;
          const sh = copiedPage.getHeight() * scale;
          page.drawPage(copiedPage as unknown as PDFEmbeddedPage, {
            x: (pw - sw) / 2,
            y: (ph - sh) / 2,
            width: sw,
            height: sh,
            xScale: scale,
            yScale: scale,
          });
        }
      }
      const bytes = await newDoc.save();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file?.name.replace(".pdf", "") || "print"}-ready.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: t("studioExported"), variant: "success" });
    } catch {
      toast({ title: t("studioExportFailed"), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const exportAsImages = async () => {
    if (sources.length === 0 || pages.length === 0) return;
    setExporting(true);
    try {
      const pdfjsLib = await getPdfjs();
      const docs = new Map<string, any>();
      const docFor = async (srcId: string) => {
        const cached = docs.get(srcId);
        if (cached) return cached;
        const src = sources.find((s) => s.id === srcId);
        if (!src) return null;
        const doc = await pdfjsLib.getDocument({ data: src.bytes.slice(0), ...PDF_DOC_OPTIONS }).promise;
        docs.set(srcId, doc);
        return doc;
      };
      const scale = 2;
      for (let i = 0; i < pages.length; i++) {
        const entry = pages[i];
        const pdf = await docFor(entry.srcId);
        if (!pdf) continue;
        const page = await pdf.getPage(entry.index + 1);
        const viewport = page.getViewport({ scale, rotation: entry.rotation });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob | null>((res) =>
          canvas.toBlob(res, "image/png"),
        );
        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${file?.name.replace(".pdf", "") || "page"}_page_${i + 1}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
      for (const doc of docs.values()) {
        try { doc.destroy(); } catch { /* noop */ }
      }
      toast({ title: t("studioExported"), variant: "success" });
    } catch {
      toast({ title: t("studioExportFailed"), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const printDirectly = async () => {
    if (sources.length === 0 || pages.length === 0) return;
    try {
      const output = await buildPdfFromPages();
      // Browser fallback — no native bridge available.
      if (!isElectron()) {
        const blob = new Blob([output], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        return;
      }
      setPrinting(true);
      const saved = defaultPrinter ? printerDefaults[defaultPrinter] : undefined;
      // The studio's own controls win over the printer's saved defaults —
      // copies/color/duplex are what the operator just set in this pane.
      // Duplex here means two-sided printing along the long edge, which is
      // what the "Duplex" toggle in the studio already implies.
      const options = {
        duplexMode: duplex ? "longEdge" : "simplex",
        color: colorMode !== "bw",
        copies,
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

  const addToNewJob = async () => {
    if (!file || sources.length === 0) return;
    if (!targets.targetJob && !targets.name.trim()) return;
    setAddJobUploading(true);
    try {
      const output = await buildPdfFromPages();
      const blob = new Blob([output], { type: "application/pdf" });
      const outFile = new File([blob], file.name, { type: "application/pdf" });
      const result = await targets.save({
        file: outFile,
        preferences: {
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies,
          paperType: "normal",
        },
        pageCount: pages.length,
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
      const output = await buildPdfFromPages();
      const blob = new Blob([output], { type: "application/pdf" });
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

  const selectAll = () => {
    if (selectedPages.size === pages.length) setSelectedPages(new Set());
    else setSelectedPages(new Set(pages.map((p) => p.id)));
  };

  const selectionSummary = t("studioSelectionSummary")
    .replace("{sel}", String(selectedPages.size))
    .replace("{total}", String(pages.length));

  const totalSuffix = t("studioTotalSuffix").replace("{n}", String(getExportPageCount()));

  return (
    <div className="flex flex-col lg:flex-row gap-4" dir={isRtl ? "rtl" : "ltr"}>
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
                  <Icon name="upload" className="w-7 h-7 text-muted-foreground mb-2" />
                  <span className="text-sm font-medium text-foreground">{t("studioDropOrChoose")}</span>
                  <span className="text-xs text-muted-foreground mt-1">PDF</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
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
                    <Icon name="file-doc" className="w-5 h-5 text-primary shrink-0 mt-0.5" />
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
                    <Icon name="plus" className="w-3.5 h-3.5" />
                    <span className="truncate">{t("studioAddPdf")}</span>
                    <input
                      type="file"
                      accept="application/pdf"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        if (picked.length > 0) void appendPdfs(picked);
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
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 text-destructive hover:text-destructive hover:bg-destructive/5"
                  disabled={selectedPages.size === 0}
                  onClick={() => deletePages([...selectedPages])}
                >
                  <Icon name="trash" />
                  {t("studioDelete")}
                  {selectedPages.size > 0 && ` (${selectedPages.size})`}
                </Button>
              </CardContent>
            </Card>

            {/* Print options */}
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm font-semibold">{t("printOptions")}</CardTitle>
              </CardHeader>
              {/* One row shape for every setting — label on the start edge,
                  control on the end edge — so the four different widgets read
                  as one list instead of four unrelated blocks. */}
              <CardContent className="p-4 pt-0 divide-y divide-border">
                <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
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
                  <Select value={paperSize} onValueChange={setPaperSize}>
                    <SelectTrigger className="h-8 w-[124px] shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAPER_SIZES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

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
              <Button className="w-full gap-2" onClick={printDirectly} disabled={printing}>
                <Icon name="print" />
                {printing ? (isRtl ? "جارٍ الإرسال..." : "Sending...") : t("studioPrintDirect")}
              </Button>
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
                <p className="text-xs text-muted-foreground mt-0.5">{totalSuffix}</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {pages.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl bg-muted/30 border border-dashed border-border py-16 px-6 text-center">
                <div className="w-14 h-14 rounded-full bg-background border flex items-center justify-center mb-4">
                  <Icon name="file-doc" className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t("studioNoPdfYet")}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t("studioNoPdfHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                {pages.map((entry, idx) => (
                  <div key={entry.id} className="group">
                    <div
                      role="button"
                      tabIndex={0}
                      aria-pressed={selectedPages.has(entry.id)}
                      draggable
                      onDragStart={() => setDragId(entry.id)}
                      onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== entry.id) movePage(dragId, entry.id); }}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => toggleSelect(entry.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSelect(entry.id);
                        }
                      }}
                      className={cn(
                        "relative rounded-lg border bg-background overflow-hidden cursor-pointer transition-all",
                        "hover:border-primary/40 hover:shadow-sm",
                        selectedPages.has(entry.id) && "border-primary ring-2 ring-primary/25",
                        dragId === entry.id && "opacity-40",
                      )}
                    >
                      <div className="flex items-center justify-center bg-muted/40 p-2" style={{ height: THUMB_H }}>
                        {thumbnails[entry.id] ? (
                          <img
                            src={thumbnails[entry.id]}
                            alt={`${tPages} ${idx + 1}`}
                            className="max-w-full max-h-full object-contain rounded-sm shadow-sm bg-white"
                            style={{ transform: `rotate(${entry.rotation}deg)` }}
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

                      {/* Hover quick actions */}
                      <div className="absolute top-1.5 end-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); rotatePages([entry.id], 90); }}
                          className="bg-background/90 backdrop-blur border hover:bg-background text-foreground rounded p-1 shadow-sm"
                          title={t("studioRotate90CW")}
                         aria-label={t("studioRotate90CW")}>
                          <Icon name="rotate-cw" className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); deletePages([entry.id]); }}
                          className="bg-background/90 backdrop-blur border hover:bg-destructive hover:text-destructive-foreground text-destructive rounded p-1 shadow-sm"
                          title={t("studioDelete")}
                         aria-label={t("studioDelete")}>
                          <Icon name="x" className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
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
          if (jobLoaderMode === "add" && sources.length > 0) void appendPdfs([f]);
          else void handleLoadFromJob(job, f);
        }}
        filterType="pdf"
      />

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
