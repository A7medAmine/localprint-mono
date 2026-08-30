import React, { useState, useRef, useEffect, useCallback } from "react";
import { PDFDocument, degrees } from "pdf-lib";
import { renderPdfFirstPageToDataUrl } from "../lib/pdfRender";
import LoadJobModal from "../components/LoadJobModal";
import ImageEditor from "../components/ImageEditor";
import { useLanguage } from "../lib/useLanguage";
import { cn } from "@localprint/shared";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { toast } from "../components/ui/use-toast";
import { isElectron, printData } from "../lib/electronPrint";
import { storageService } from "../services/storageService";
import type { PrinterJobDefaults } from "../types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";

const MM_TO_PT = 2.83465;
const SCALE = 0.45;
const PAPER_SIZES: { label: string; w: number; h: number }[] = [
  { label: "A4 (210x297mm)", w: 595.28, h: 841.89 },
  { label: "A3 (297x420mm)", w: 841.89, h: 1190.55 },
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

function readFileAsDataUrl(f: File | null | undefined): Promise<string> {
  if (!f) return Promise.reject(new Error("No file provided"));
  return new Promise((resolve, reject) => {
    if (f.type === "application/pdf") {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = (e) => {
        const buf = e.target?.result as ArrayBuffer;
        // <img> can't rasterise PDF — go through the shared pdf.js path.
        renderPdfFirstPageToDataUrl(buf).then(resolve).catch(reject);
      };
      reader.readAsArrayBuffer(f);
    } else if (f.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(f);
    } else {
      reject(new Error("Unsupported file type"));
    }
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function embedImageInPdf(pdfDoc: PDFDocument, dataUrl: string) {
  const isJpeg = dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg");
  const bytes = dataUrlToBytes(dataUrl);
  return isJpeg ? pdfDoc.embedJpg(bytes) : pdfDoc.embedPng(bytes);
}

function containFit(imgW: number, imgH: number, boxW: number, boxH: number) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

const AUTO_MARGIN_MM = 5;
const AUTO_GAP_MM = 3;

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

  // Among equal-waste splits, prefer the most balanced grid (cols close to
  // rows) so cards cluster into a compact block instead of a long single
  // row/column with empty space down the sides.
  let best = { cols: maxCols, rows: 1, waste: Infinity, balance: Infinity };
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.min(maxRows, Math.ceil(wanted / cols));
    if (cols * rows < wanted) continue;
    const waste = cols * rows - wanted;
    const balance = Math.abs(cols - rows);
    if (waste < best.waste || (waste === best.waste && balance < best.balance)) {
      best = { cols, rows, waste, balance };
    }
  }

  const hGapPt = best.cols > 1 ? gap : 0;
  const vGapPt = best.rows > 1 ? gap : 0;
  const gridW = best.cols * cardW + (best.cols - 1) * hGapPt;
  const gridH = best.rows * cardH + (best.rows - 1) * vGapPt;
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

const CardIDTool: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [frontDataUrl, setFrontDataUrl] = useState<string | null>(null);
  const [backDataUrl, setBackDataUrl] = useState<string | null>(null);
  const [frontRot, setFrontRot] = useState(0);
  const [backRot, setBackRot] = useState(0);
  const [editingTarget, setEditingTarget] = useState<"front" | "back" | null>(null);
  const [editingBlob, setEditingBlob] = useState<Blob | null>(null);
  const [showJobLoader, setShowJobLoader] = useState(false);
  const [loadTarget, setLoadTarget] = useState<"front" | "back">("front");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showJobForm, setShowJobForm] = useState(false);
  const [jobName, setJobName] = useState("");
  const [jobPhone, setJobPhone] = useState("");
  const [jobNotes, setJobNotes] = useState("");
  const [lastPdfBlob, setLastPdfBlob] = useState<Blob | null>(null);
  const [multiCard, setMultiCard] = useState(false);
  const [copies, setCopies] = useState(4);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [paperIdx, setPaperIdx] = useState(0);
  // Card printing is duplex by default — front sheet + back sheet on the same
  // physical card. Kept togglable in case someone's printer can't duplex or
  // they're printing to two separate sheets.
  const [duplex, setDuplex] = useState(true);
  const [colorMode, setColorMode] = useState<"color" | "bw">("color");
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
  const PP_W = PAPER_SIZES[paperIdx].w;
  const PP_H = PAPER_SIZES[paperIdx].h;
  const PAD = 10 * MM_TO_PT;
  const cardW = CARD_SIZES[sizeIdx].w * MM_TO_PT;
  const cardH = CARD_SIZES[sizeIdx].h * MM_TO_PT;
  const { capacity: maxCapacity, cols: layoutCols, rows: layoutRows } = autoLayout(copies, cardW, cardH, PP_W, PP_H);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const backCanvasRef = useRef<HTMLCanvasElement>(null);

  const handleFrontFile = useCallback(async (f: File) => {
    setExportError("");
    setFrontFile(f);
    try {
      setFrontDataUrl(await readFileAsDataUrl(f));
    } catch (e: any) {
      setExportError("Front image: " + (e.message || "failed to load"));
    }
  }, []);

  const handleBackFile = useCallback(async (f: File) => {
    setExportError("");
    setBackFile(f);
    try {
      setBackDataUrl(await readFileAsDataUrl(f));
    } catch (e: any) {
      setExportError("Back image: " + (e.message || "failed to load"));
    }
  }, []);

  const dataUrlToBlob = (dataUrl: string): Blob => {
    const bytes = dataUrlToBytes(dataUrl);
    const type = dataUrl.match(/^data:([^;]+);/)?.[1] || "image/png";
    return new Blob([bytes], { type });
  };

  const openEditor = (target: "front" | "back") => {
    const dataUrl = target === "front" ? frontDataUrl : backDataUrl;
    if (!dataUrl?.startsWith("data:image")) return;
    setEditingTarget(target);
    setEditingBlob(dataUrlToBlob(dataUrl));
  };

  // Save the edited image straight back into the card face it came from and
  // re-render the preview — no re-upload needed.
  const handleEditedImageSave = useCallback(async (newBlob: Blob) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read edited image"));
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsDataURL(newBlob);
      });
      const name = (editingTarget === "front" ? frontFile?.name : backFile?.name) || "edited-image.png";
      const file = new File([newBlob], name, { type: newBlob.type || "image/png" });
      if (editingTarget === "front") {
        setFrontFile(file);
        setFrontDataUrl(dataUrl);
      } else if (editingTarget === "back") {
        setBackFile(file);
        setBackDataUrl(dataUrl);
      }
      toast({ title: isRtl ? "تم تحديث الصورة" : "Image updated", variant: "success" });
    } catch (e: any) {
      setExportError("Edit: " + (e.message || "failed to apply"));
    } finally {
      setEditingTarget(null);
      setEditingBlob(null);
    }
  }, [editingTarget, frontFile, backFile, isRtl]);

  const drawPreview = (canvas: HTMLCanvasElement | null, dataUrl: string | null, isFront: boolean, rot: number) => {
    if (!canvas || !dataUrl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pw = PP_W * SCALE;
    const ph = PP_H * SCALE;
    canvas.width = pw;
    canvas.height = ph;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pw, ph);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, pw, ph);
    const slots = multiCard
      ? autoLayout(copies, cardW, cardH, PP_W, PP_H).slots
      : [{
          x: isFront ? PAD : PP_W - PAD - cardW,
          y: PP_H - PAD - cardH,
          w: cardW,
          h: cardH,
        }];
    const img = new Image();
    img.onload = () => {
      for (const slot of slots) {
        const cw = slot.w * SCALE;
        const ch = slot.h * SCALE;
        const cx = slot.x * SCALE;
        const cy = (PP_H - slot.y - slot.h) * SCALE;
        ctx.fillStyle = "#e5e7eb";
        ctx.fillRect(cx, cy, cw, ch);
        ctx.strokeStyle = "#9ca3af";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(cx, cy, cw, ch);
        const rotated = rot % 180 !== 0;
        const iw = img.naturalWidth || cw;
        const ih = img.naturalHeight || ch;
        const fitted = containFit(rotated ? ih : iw, rotated ? iw : ih, cw, ch);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
        ctx.translate(cx + cw / 2, cy + ch / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -fitted.w / 2, -fitted.h / 2, fitted.w, fitted.h);
        ctx.restore();
      }
    };
    img.src = dataUrl;
  };

  useEffect(() => { drawPreview(frontCanvasRef.current, frontDataUrl, true, frontRot); }, [frontDataUrl, multiCard, copies, sizeIdx, paperIdx, frontRot]);
  useEffect(() => { drawPreview(backCanvasRef.current, backDataUrl, false, backRot); }, [backDataUrl, multiCard, copies, sizeIdx, paperIdx, backRot]);

  // Auto-load front/back images from bulk "Print as Card" action
  useEffect(() => {
    const frontId = sessionStorage.getItem("ps_card_front");
    const backId = sessionStorage.getItem("ps_card_back");
    if (!frontId && !backId) return;
    sessionStorage.removeItem("ps_card_front");
    sessionStorage.removeItem("ps_card_back");
    (async () => {
      if (frontId) {
        try {
          const res = await fetch(`/api/files/public/${frontId}`);
          if (res.ok) {
            const blob = await res.blob();
            const file = new File([blob], frontId, { type: blob.type || "image/png" });
            await handleFrontFile(file);
          }
        } catch {}
      }
      if (backId) {
        try {
          const res = await fetch(`/api/files/public/${backId}`);
          if (res.ok) {
            const blob = await res.blob();
            const file = new File([blob], backId, { type: blob.type || "image/png" });
            await handleBackFile(file);
          }
        } catch {}
      }
    })();
  }, [handleFrontFile, handleBackFile]);

  const generatePdf = async (): Promise<Blob | null> => {
    if (!frontDataUrl && !backDataUrl) return null;
    setExportError("");
    setExporting(true);
    try {
      const pdfDoc = await PDFDocument.create();
      const slots = multiCard
        ? autoLayout(copies, cardW, cardH, PP_W, PP_H).slots
        : [{
            x: PAD,
            y: PP_H - PAD - cardH,
            w: cardW,
            h: cardH,
          }];

      const addPage = async (dataUrl: string, isFront: boolean, rot: number) => {
        const page = pdfDoc.addPage([PP_W, PP_H]);
        const img = await embedImageInPdf(pdfDoc, dataUrl);
        for (const slot of slots) {
          const sx = isFront ? slot.x : PP_W - slot.x - slot.w;
          const rotated = rot % 180 !== 0;
          const fitted = containFit(rotated ? img.height : img.width, rotated ? img.width : img.height, slot.w, slot.h);
          page.drawImage(img, {
            x: sx + (slot.w - fitted.w) / 2,
            y: slot.y + (slot.h - fitted.h) / 2,
            width: fitted.w,
            height: fitted.h,
            rotate: degrees(rot),
          });
        }
      };

      if (frontDataUrl) await addPage(frontDataUrl, true, frontRot);
      if (backDataUrl) await addPage(backDataUrl, false, backRot);

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      setLastPdfBlob(blob);
      return blob;
    } catch (e: any) {
      setExportError(e?.message || "Export failed");
      return null;
    } finally {
      setExporting(false);
    }
  };

  const handleDownload = async () => {
    const blob = await generatePdf();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "id-card-duplex.pdf";
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
      // Duplex: user's toggle wins. Long-edge is the standard for card layouts
      // where front is on the left half and back on the right half of the same
      // page, so flipping along the long edge aligns them.
      // Color: pane toggle wins over the printer's saved default. `color: false`
      // is translated in electron/main.js into a CSS grayscale filter on the
      // hidden print window (Chromium's own color:false path prints solid
      // black on this driver stack).
      const options = {
        duplexMode: duplex ? "longEdge" : "simplex",
        color: colorMode !== "bw",
        copies: saved?.copies ?? 1,
        collate: saved?.collate ?? true,
        landscape: saved?.landscape ?? false,
      } as const;
      const result = await printData({
        data: bytes,
        fileType: "application/pdf",
        printerName: printer,
        silent: !!printer,
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

  const handleAddToJobs = async () => {
    // Only open the form if we actually have a fresh PDF — a failed
    // generatePdf() used to still open the form and let submitJob upload a
    // stale blob (or nothing).
    const blob = await generatePdf();
    if (!blob) return;
    setShowJobForm(true);
  };

  const submitJob = async () => {
    if (!jobName.trim()) return;
    setExportError("");
    setExporting(true);
    try {
      // Regenerate from current state — the user may have changed size/color/
      // layout between opening the form and hitting "Add job".
      const blob = await generatePdf();
      if (!blob) throw new Error(exportError || "Could not generate the card PDF");
      const file = new File([blob], "id-cards.pdf", { type: "application/pdf" });
      const metadata = JSON.stringify({
        customerName: jobName.trim(),
        phoneNumber: jobPhone.trim(),
        notes: jobNotes.trim(),
        fileName: "id-cards.pdf",
        status: "PENDING",
        source: "card-tool",
        printPreferences: {
          // Server/pricing expect "blackWhite"/"color", not this tool's "bw".
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies: 1,
          paperType: "cardboard",
        },
      });
      const body = new FormData();
      body.append("file", file);
      body.append("metadata", metadata);
      const res = await fetch("/api/upload", { method: "POST", body });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      setShowJobForm(false);
      setJobName("");
      setJobPhone("");
      setJobNotes("");
      setLastPdfBlob(null);
      toast({ title: isRtl ? "تمت إضافة المهمة" : "Job added", variant: "success" });
    } catch (e: any) {
      setExportError(e?.message || "Failed to add job");
    } finally {
      setExporting(false);
    }
  };

  const jobLoaderSelect = (job: any, file: File | null) => {
    if (!file) return;
    setExportError("");
    if (loadTarget === "front") handleFrontFile(file);
    else handleBackFile(file);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-4">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("frontImage")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {!frontFile ? (
              <div className="space-y-3">
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-input rounded-xl p-4 cursor-pointer hover:border-primary/50 transition">
                  <svg className="w-6 h-6 text-muted-foreground mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <span className="text-xs text-muted-foreground">{t("uploadFront")}</span>
                  <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFrontFile(f); }} />
                </label>
                <Button variant="link" size="sm" className="w-full text-xs" onClick={() => { setLoadTarget("front"); setShowJobLoader(true); }}>
                  {t("loadFromJobs")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 truncate text-sm">{frontFile.name}</div>
                <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" title={isRtl ? "تحرير الصورة" : "Edit image"} disabled={!frontDataUrl?.startsWith("data:image")} onClick={() => openEditor("front")}>
                  {isRtl ? "تحرير" : "Edit"}
                </Button>
                <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" title={isRtl ? "تدوير 90 درجة" : "Rotate 90°"} onClick={() => setFrontRot((r) => (r + 90) % 360)}>
                  ⟳ {frontRot ? `${frontRot}°` : ""}
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive h-auto px-2 py-1 text-xs" onClick={() => { setFrontFile(null); setFrontDataUrl(null); setFrontRot(0); }}>
                  {t("remove")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("backImage")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {!backFile ? (
              <div className="space-y-3">
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-input rounded-xl p-4 cursor-pointer hover:border-primary/50 transition">
                  <svg className="w-6 h-6 text-muted-foreground mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <span className="text-xs text-muted-foreground">{t("uploadBack")}</span>
                  <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBackFile(f); }} />
                </label>
                <Button variant="link" size="sm" className="w-full text-xs" onClick={() => { setLoadTarget("back"); setShowJobLoader(true); }}>
                  {t("loadFromJobs")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 truncate text-sm">{backFile.name}</div>
                <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" title={isRtl ? "تحرير الصورة" : "Edit image"} disabled={!backDataUrl?.startsWith("data:image")} onClick={() => openEditor("back")}>
                  {isRtl ? "تحرير" : "Edit"}
                </Button>
                <Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" title={isRtl ? "تدوير 90 درجة" : "Rotate 90°"} onClick={() => setBackRot((r) => (r + 90) % 360)}>
                  ⟳ {backRot ? `${backRot}°` : ""}
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive h-auto px-2 py-1 text-xs" onClick={() => { setBackFile(null); setBackDataUrl(null); setBackRot(0); }}>
                  {t("remove")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between rounded-xl border border-input px-3 py-2">
          <div className="min-w-0">
            <Label className="text-xs font-medium cursor-pointer">
              {isRtl ? "طباعة على الوجهين" : "Duplex printing"}
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isRtl
                ? "الأمام والخلف على نفس البطاقة (افتراضي)"
                : "Front and back on the same card (default)"}
            </p>
          </div>
          <Switch checked={duplex} onCheckedChange={setDuplex} />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-input px-3 py-2">
          <div className="min-w-0">
            <Label className="text-xs font-medium cursor-pointer">
              {isRtl ? "أبيض وأسود" : "Black & white"}
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isRtl
                ? "طباعة رمادية بدلاً من الألوان"
                : "Print grayscale instead of color"}
            </p>
          </div>
          <Switch
            checked={colorMode === "bw"}
            onCheckedChange={(on) => setColorMode(on ? "bw" : "color")}
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-input px-3 py-2">
          <div className="min-w-0">
            <Label className="text-xs font-medium cursor-pointer">
              {isRtl ? "نسخ متعددة في نفس الورقة" : "Multiple copies per sheet"}
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isRtl
                ? "طباعة عدة بطاقات على نفس الصفحة"
                : "Print several cards on one paper sheet"}
            </p>
          </div>
          <Switch checked={multiCard} onCheckedChange={setMultiCard} />
        </div>

        {multiCard && (
          <div className="rounded-xl border border-input px-3 py-3 space-y-2">
            <Label className="text-xs">{isRtl ? "عدد النسخ" : "Number of copies"}</Label>
            <Input
              type="number"
              min={1}
              max={maxCapacity}
              value={copies}
              onChange={(e) => setCopies(Math.max(1, Math.min(maxCapacity, Number(e.target.value) || 1)))}
            />
            <p className="text-[11px] text-muted-foreground">
              {isRtl
                ? `أقصى عدد يناسب الصفحة: ${maxCapacity} (${layoutCols}×${layoutRows})`
                : `Fits up to ${maxCapacity} per sheet (${layoutCols}×${layoutRows} layout), packed automatically`}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Button
            disabled={(!frontDataUrl && !backDataUrl) || exporting}
            onClick={handleDownload}
          >
            {exporting ? "..." : t("download")}
          </Button>
          <Button
            disabled={(!frontDataUrl && !backDataUrl) || exporting || printing}
            variant="secondary"
            onClick={handlePrint}
          >
            {printing ? "..." : t("print")}
          </Button>
          <Button
            disabled={(!frontDataUrl && !backDataUrl) || exporting}
            variant="outline"
            onClick={handleAddToJobs}
          >
            {t("addToJobs")}
          </Button>
        </div>

        {exportError && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-xl p-3 border border-destructive/20">{exportError}</div>
        )}

        <Dialog open={showJobForm} onOpenChange={setShowJobForm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("addToJobsTitle")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>{t("customerNameRequired")}</Label>
                <Input value={jobName} onChange={(e) => setJobName(e.target.value)} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>{t("phone")}</Label>
                <Input value={jobPhone} onChange={(e) => setJobPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("studioNotes")}</Label>
                <Textarea value={jobNotes} onChange={(e) => setJobNotes(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowJobForm(false)}>{t("studioCancel")}</Button>
              <Button disabled={!jobName.trim() || exporting} onClick={submitJob}>
                {exporting ? t("uploading") : t("addJob")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="lg:col-span-2">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("preview")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {!frontDataUrl && !backDataUrl ? (
              <div className="flex items-center justify-center h-[300px] bg-muted/30 rounded-xl text-muted-foreground text-sm">{t("noImages")}</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 text-center">{t("page1")}</p>
                  {frontDataUrl ? (
                    <div className="flex justify-center">
                      <canvas ref={frontCanvasRef} className="shadow-lg rounded-xl border max-w-full" style={{ maxHeight: "60vh" }} />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] bg-muted/30 rounded-xl text-muted-foreground text-xs">{t("noImage")}</div>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 text-center">{t("page2")}</p>
                  {backDataUrl ? (
                    <div className="flex justify-center">
                      <canvas ref={backCanvasRef} className="shadow-lg rounded-xl border max-w-full" style={{ maxHeight: "60vh" }} />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px] bg-muted/30 rounded-xl text-muted-foreground text-xs">{t("noImage")}</div>
                  )}
                </div>
              </div>
            )}
            <div className="mt-3 text-xs text-muted-foreground text-center">
              {CARD_SIZES[sizeIdx].label} &middot; {t("page1Left")}
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

      {editingTarget && editingBlob && (
        <ImageEditor
          imageBlob={editingBlob}
          lang={lang}
          onSave={handleEditedImageSave}
          onCancel={() => { setEditingTarget(null); setEditingBlob(null); }}
        />
      )}
    </div>
  );
};

export default CardIDTool;
