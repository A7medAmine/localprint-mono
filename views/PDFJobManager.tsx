import React, { useState, useRef, useEffect, useCallback } from "react";
import { PDFDocument, PageSizes, degrees } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { getPdfWorkerUrl } from "../lib/pdfWorker";
import LoadJobModal from "../components/LoadJobModal";
import { useLanguage } from "../lib/useLanguage";
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
import { cn } from "../lib/utils";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { isElectron, printData } from "../lib/electronPrint";
import type { PrintJob, PrinterJobDefaults } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = getPdfWorkerUrl();

interface PageEntry {
  id: string;
  index: number;
  rotation: number;
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

function normRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// Small stroked icons — matches the rest of the app's design language and
// avoids emoji width/rendering inconsistencies across OSes.
const Icon = ({ d, className }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn("w-4 h-4", className)}>
    <path d={d} />
  </svg>
);
const ICONS = {
  upload: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2 M7 9l5-5 5 5 M12 4v12",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6",
  trash: "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  rotateCW: "M21 12a9 9 0 1 1-3-6.7 M21 4v5h-5",
  rotateCCW: "M3 12a9 9 0 1 0 3-6.7 M3 4v5h5",
  flip: "M8 3v18 M16 3v18 M3 12h18",
  printer: "M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z",
  download: "M12 3v12 M6 11l6 6 6-6 M4 21h16",
  image: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M21 15l-5-5L4 20",
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M6 18L18 6",
  minus: "M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
} as const;

const PDFJobManager: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";

  const [file, setFile] = useState<File | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
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
  const [showNewJobDialog, setShowNewJobDialog] = useState(false);
  const [addJobName, setAddJobName] = useState("");
  const [addJobPhone, setAddJobPhone] = useState("");
  const [addJobNotes, setAddJobNotes] = useState("");
  const [addJobUploading, setAddJobUploading] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [defaultPrinter, setDefaultPrinter] = useState<string>("");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>({});

  useEffect(() => {
    if (!isElectron()) return;
    storageService.getSettings().then((s) => {
      setDefaultPrinter(s.defaultPrinterName || "");
      setPrinterDefaults(s.printerDefaults || {});
    }).catch(() => {});
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const tPages = t("studioPagesLabel");

  const renderThumbnails = useCallback(async (buf: ArrayBuffer, pageEntries: PageEntry[]) => {
    try {
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      const results: Record<string, string> = {};
      for (const entry of pageEntries) {
        try {
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
    } catch (err) {
      console.error("pdf.js failed to open document:", err);
      toast({
        title: isRtl ? "تعذر عرض المعاينات" : "Could not render previews",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }, [isRtl]);

  const loadPdf = useCallback(async (f: File, buf: ArrayBuffer, restoredPages?: PageEntry[]) => {
    setFile(f);
    const pdf = await PDFDocument.load(buf);
    const count = pdf.getPageCount();
    const entries: PageEntry[] =
      restoredPages && restoredPages.length > 0
        ? restoredPages.filter((p) => p.index < count)
        : Array.from({ length: count }, (_, i) => ({
            id: crypto.randomUUID(),
            index: i,
            rotation: 0,
          }));
    setPages(entries);
    setPdfBytes(buf);
    setSelectedPages(new Set());
    setThumbnails({});
    renderThumbnails(buf, entries);
  }, [renderThumbnails]);

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

  // Re-render thumbnails on rotation / reorder — pdfBytes stays stable so the
  // dep set is intentionally narrow (avoids the `renderThumbnails` dep loop
  // the previous version had).
  useEffect(() => {
    if (pdfBytes && pages.length > 0) {
      renderThumbnails(pdfBytes, pages);
    }
  }, [pages, pdfBytes, renderThumbnails]);

  // On mount: restore a session (either from admin's "Edit" action, or
  // sessionStorage if we were mid-work before a refresh / lang toggle).
  useEffect(() => {
    const editJobId = sessionStorage.getItem("ps_edit_job");
    const savedRaw = sessionStorage.getItem(SESSION_KEY);
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
        const token = localStorage.getItem("ps_admin_token");
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/jobs", { headers });
        const jobs = await res.json();
        const job = Array.isArray(jobs) ? jobs.find((j: any) => j.id === targetJobId) : null;
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

  // Persist just enough to restore a job-loaded PDF on refresh/lang change.
  // Manually uploaded PDFs aren't persisted (would need IndexedDB for the
  // bytes) — clearing here also handles the "user removed the file" case.
  useEffect(() => {
    if (!sourceJob || pages.length === 0) {
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
  }, [sourceJob, pages, copies, colorMode, paperSize, duplex]);

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

  const buildPdfFromPages = async (): Promise<Uint8Array> => {
    if (!pdfBytes) throw new Error("No PDF loaded");
    const sourcePdf = await PDFDocument.load(pdfBytes.slice(0));
    const newDoc = await PDFDocument.create();
    for (const entry of pages) {
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
    if (!pdfBytes) return;
    setExporting(true);
    try {
      const sourcePdf = await PDFDocument.load(pdfBytes.slice(0));
      const newDoc = await PDFDocument.create();
      const sizeKey = paperSize as keyof typeof PageSizes;
      const targetSize = PageSizes[sizeKey] || PageSizes.A4;

      for (let c = 0; c < copies; c++) {
        for (const entry of pages) {
          const [copiedPage] = await newDoc.copyPages(sourcePdf, [entry.index]);
          const rot = normRotation(entry.rotation);
          if (rot !== 0) copiedPage.setRotation(degrees(rot));
          const [pw, ph] = targetSize;
          const page = newDoc.addPage(targetSize);
          const scale = Math.min(pw / copiedPage.getWidth(), ph / copiedPage.getHeight());
          const sw = copiedPage.getWidth() * scale;
          const sh = copiedPage.getHeight() * scale;
          page.drawPage(copiedPage, {
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
    if (!pdfBytes || pages.length === 0) return;
    setExporting(true);
    try {
      const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
      const scale = 2;
      for (let i = 0; i < pages.length; i++) {
        const entry = pages[i];
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
      toast({ title: t("studioExported"), variant: "success" });
    } catch {
      toast({ title: t("studioExportFailed"), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const printDirectly = async () => {
    if (!pdfBytes || pages.length === 0) return;
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
        silent: !!defaultPrinter,
        options,
      });
      if (result.cancelled) {
        toast({ title: isRtl ? "تم إلغاء الطباعة" : "Print cancelled" });
      } else if (result.ok) {
        toast({ title: isRtl ? "تم إرسال المهمة" : "Sent to printer", variant: "success" });
      }
    } catch (err: any) {
      toast({
        title: isRtl ? "فشل الطباعة" : "Print failed",
        description: err?.message,
        variant: "destructive",
      });
    } finally {
      setPrinting(false);
    }
  };

  const addToNewJob = async () => {
    if (!file || !pdfBytes) return;
    setAddJobUploading(true);
    try {
      const output = await buildPdfFromPages();
      const blob = new Blob([output], { type: "application/pdf" });
      const outFile = new File([blob], file.name, { type: "application/pdf" });
      const job: PrintJob = {
        id: crypto.randomUUID(),
        customerName: addJobName,
        phoneNumber: addJobPhone,
        notes: addJobNotes,
        fileName: file.name,
        fileType: "application/pdf",
        fileSize: blob.size,
        uploadDate: new Date().toISOString(),
        status: "PENDING" as any,
        pageCount: pages.length,
        printPreferences: {
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies,
          paperType: "normal",
        },
      };
      await storageService.saveJob(job, outFile);
      setShowNewJobDialog(false);
      setAddJobName("");
      setAddJobPhone("");
      setAddJobNotes("");
      toast({ title: t("studioJobCreated"), variant: "success" });
    } catch (err: any) {
      toast({ title: t("studioSaveFailed"), description: err.message, variant: "destructive" });
    } finally {
      setAddJobUploading(false);
    }
  };

  const saveToSourceJob = async () => {
    if (!sourceJob || !file || !pdfBytes) return;
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
    } catch (err: any) {
      toast({ title: t("studioSaveFailed"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const clearFile = () => {
    setFile(null);
    setPdfBytes(null);
    setPages([]);
    setThumbnails({});
    setSelectedPages(new Set());
    setSourceJob(null);
    sessionStorage.removeItem(SESSION_KEY);
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
      {/* Sidebar */}
      <aside className="w-full lg:w-[320px] lg:shrink-0 space-y-3">
        {/* Source PDF */}
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm font-semibold">{t("sourcePDF")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {!file ? (
              <>
                <label className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-input bg-muted/30 py-6 px-4 cursor-pointer hover:border-primary/60 hover:bg-muted/50 transition-colors">
                  <Icon d={ICONS.upload} className="w-7 h-7 text-muted-foreground mb-2" />
                  <span className="text-sm font-medium text-foreground">{t("studioDropOrChoose")}</span>
                  <span className="text-[11px] text-muted-foreground mt-1">PDF</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                  />
                </label>
                <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => setShowJobLoader(true)}>
                  <Icon d={ICONS.folder} />
                  {t("loadFromPrintJobs")}
                </Button>
              </>
            ) : (
              <div className="space-y-2">
                <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-2.5">
                  <Icon d={ICONS.file} className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" title={file.name}>{file.name}</div>
                    {sourceJob && (
                      <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {t("studioFromJob")}: {sourceJob.customerName || (isRtl ? "بدون اسم" : "Unknown")}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="text-muted-foreground hover:text-destructive p-1 -m-1 shrink-0"
                    aria-label={t("remove")}
                    title={t("remove")}
                  >
                    <Icon d={ICONS.close} />
                  </button>
                </div>
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
                <p className="text-[11px] text-muted-foreground mt-1">{selectionSummary}</p>
              </CardHeader>
              <CardContent className="p-4 pt-0 space-y-2">
                <div className="grid grid-cols-3 gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], 90)}
                    title={t("studioRotate90CW")}
                  >
                    <Icon d={ICONS.rotateCW} className="w-3.5 h-3.5" />
                    <span className="text-[10px]">90°</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], -90)}
                    title={t("studioRotate90CCW")}
                  >
                    <Icon d={ICONS.rotateCCW} className="w-3.5 h-3.5" />
                    <span className="text-[10px]">-90°</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-0 flex-col gap-0.5"
                    disabled={selectedPages.size === 0}
                    onClick={() => rotatePages([...selectedPages], 180)}
                    title={t("studioRotate180")}
                  >
                    <Icon d={ICONS.flip} className="w-3.5 h-3.5" />
                    <span className="text-[10px]">180°</span>
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 text-destructive hover:text-destructive hover:bg-destructive/5"
                  disabled={selectedPages.size === 0}
                  onClick={() => deletePages([...selectedPages])}
                >
                  <Icon d={ICONS.trash} />
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
              <CardContent className="p-4 pt-0 space-y-3">
                {/* Copies stepper */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("copies")}</Label>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={copies <= 1}
                      onClick={() => setCopies((c) => Math.max(1, c - 1))}
                    >
                      <Icon d={ICONS.minus} />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      max={999}
                      value={copies}
                      onChange={(e) => setCopies(Math.max(1, Math.min(999, parseInt(e.target.value) || 1)))}
                      className="h-8 text-center"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={copies >= 999}
                      onClick={() => setCopies((c) => Math.min(999, c + 1))}
                    >
                      <Icon d={ICONS.plus} />
                    </Button>
                  </div>
                </div>

                {/* Color mode */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("colorMode")}</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant={colorMode === "color" ? "default" : "outline"}
                      onClick={() => setColorMode("color")}
                      className="h-8"
                    >
                      {t("color")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={colorMode === "bw" ? "default" : "outline"}
                      onClick={() => setColorMode("bw")}
                      className="h-8"
                    >
                      {t("bw")}
                    </Button>
                  </div>
                </div>

                {/* Paper size */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t("studioPaperSize")}</Label>
                  <Select value={paperSize} onValueChange={setPaperSize}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAPER_SIZES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Duplex */}
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                  <Label htmlFor="duplex-switch" className="text-xs font-medium cursor-pointer">
                    {t("studioDuplex")}
                  </Label>
                  <Switch id="duplex-switch" checked={duplex} onCheckedChange={setDuplex} />
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm font-semibold">{t("studioActions")}</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 space-y-2">
                <Button className="w-full gap-2" size="sm" onClick={printDirectly} disabled={printing}>
                  <Icon d={ICONS.printer} />
                  {printing ? (isRtl ? "جارٍ الإرسال..." : "Sending...") : t("studioPrintDirect")}
                </Button>
                <Button className="w-full gap-2" size="sm" variant="outline" onClick={exportPDF} disabled={exporting}>
                  <Icon d={ICONS.download} />
                  {exporting ? t("exporting") : t("studioExportPDF")}
                </Button>
                <Button className="w-full gap-2" size="sm" variant="outline" onClick={exportAsImages} disabled={exporting}>
                  <Icon d={ICONS.image} />
                  {exporting ? t("exporting") : t("studioExportImages")}
                </Button>
                <div className="pt-1">
                  {sourceJob ? (
                    <Button className="w-full gap-2" size="sm" variant="secondary" onClick={saveToSourceJob} disabled={saving}>
                      <Icon d={ICONS.save} />
                      {saving ? t("uploading") : t("studioSaveToJob")}
                    </Button>
                  ) : (
                    <Button className="w-full gap-2" size="sm" variant="secondary" onClick={() => setShowNewJobDialog(true)}>
                      <Icon d={ICONS.plus} />
                      {t("studioSaveAsNewJob")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </aside>

      {/* Main */}
      <section className="flex-1 min-w-0">
        <Card>
          <CardHeader className="p-4 pb-3 flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">
                {tPages}
                {pages.length > 0 && <span className="text-muted-foreground font-normal ms-1">({pages.length})</span>}
              </CardTitle>
              {pages.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-0.5">{totalSuffix}</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {pages.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl bg-muted/30 border border-dashed border-border py-16 px-6 text-center">
                <div className="w-14 h-14 rounded-full bg-background border flex items-center justify-center mb-4">
                  <Icon d={ICONS.file} className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t("studioNoPdfYet")}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t("studioNoPdfHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                {pages.map((entry, idx) => (
                  <div key={entry.id} className="group">
                    <div
                      draggable
                      onDragStart={() => setDragId(entry.id)}
                      onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== entry.id) movePage(dragId, entry.id); }}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => toggleSelect(entry.id)}
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
                            <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            <span className="text-[10px]">{t("studioLoadingThumb")}</span>
                          </div>
                        )}
                      </div>

                      {/* Page number */}
                      <div className="absolute bottom-1.5 end-1.5 bg-background/90 backdrop-blur border text-foreground text-[10px] font-semibold px-1.5 py-0.5 rounded">
                        {idx + 1}
                      </div>

                      {/* Rotation badge */}
                      {entry.rotation !== 0 && (
                        <div className="absolute top-1.5 start-1.5 bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5 rounded">
                          {entry.rotation}°
                        </div>
                      )}

                      {/* Hover quick actions */}
                      <div className="absolute top-1.5 end-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); rotatePages([entry.id], 90); }}
                          className="bg-background/90 backdrop-blur border hover:bg-background text-foreground rounded p-1 shadow-sm"
                          title={t("studioRotate90CW")}
                        >
                          <Icon d={ICONS.rotateCW} className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); deletePages([entry.id]); }}
                          className="bg-background/90 backdrop-blur border hover:bg-destructive hover:text-destructive-foreground text-destructive rounded p-1 shadow-sm"
                          title={t("studioDelete")}
                        >
                          <Icon d={ICONS.close} className="w-3 h-3" />
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
        onSelect={(job, f) => { if (f) handleLoadFromJob(job, f); }}
        filterType="pdf"
      />

      <Dialog open={showNewJobDialog} onOpenChange={setShowNewJobDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("studioNewJobTitle")}</DialogTitle>
            <DialogDescription>{t("studioNewJobDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>{t("studioCustomerName")}</Label>
              <Input value={addJobName} onChange={(e) => setAddJobName(e.target.value)} placeholder={t("studioCustomerName")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("studioPhone")}</Label>
              <Input value={addJobPhone} onChange={(e) => setAddJobPhone(e.target.value)} placeholder={t("studioPhone")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("studioNotes")}</Label>
              <Input value={addJobNotes} onChange={(e) => setAddJobNotes(e.target.value)} placeholder={t("studioNotes")} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowNewJobDialog(false)}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button onClick={addToNewJob} disabled={addJobUploading || !addJobName.trim()}>
              {addJobUploading ? t("uploading") : t("studioCreate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PDFJobManager;
