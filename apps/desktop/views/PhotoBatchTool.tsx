import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { PageSpec, MarginSpec, LaidOutPage, PhotoItem as LayoutItem } from "../lib/photoLayout";
import { layoutBatch, estimateDpi, mmToPt } from "../lib/photoLayout";
import { buildPhotoPdf } from "../lib/photoPdf";
import { decodeImageToBitmap, rotateQuarterTurnsToCanvas } from "../lib/imageNormalize";
import { isElectron, printData, getPrinters, PrinterInfo } from "../lib/electronPrint";
import { storageService } from "../services/storageService";
import { useLanguage } from "../lib/useLanguage";
import { toast } from "../components/ui/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import PhotoSourceModal, { PickedPhoto } from "../components/PhotoSourceModal";
import { JobTargetPicker, useJobTargets } from "../components/JobTargetPicker";
import { consumePhotoBatchHandoff } from "../lib/photoBatchHandoff";
import type { PaperType, PrinterJobDefaults, ShopSettings } from "../types";
import { formatPrice } from "../utils/pricingUtils";
import { Icon } from "../components/ui/icon";
import { errorMessage } from "@atba3li/shared";

interface BatchItem {
  id: string;
  file: File;
  sourceJobId?: string;
  sourceCustomerName?: string;
  bitmap: ImageBitmap | HTMLImageElement | null;
  naturalWidth: number;
  naturalHeight: number;
  rotateQuarterTurns: 0 | 1 | 2 | 3;
  objectFit: "cover" | "contain" | null;
  error?: string;
}

type PaperPreset = "a4" | "a3" | "match" | "custom";
type Orientation = "auto" | "portrait" | "landscape";

const PAPER_PRESETS_MM: Record<"a4" | "a3", { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
};

function parsePrinterPageSize(info: PrinterInfo | undefined): { wmm: number; hmm: number } | null {
  const opts = info?.options || {};
  for (const [k, v] of Object.entries(opts)) {
    const lk = k.toLowerCase();
    const lv = String(v).toLowerCase();
    if (lk.includes("size") || lk.includes("paper")) {
      if (lv.includes("a4") || lv === "a4") return { wmm: 210, hmm: 297 };
      if (lv.includes("a3") || lv === "a3") return { wmm: 297, hmm: 420 };
      if (lv.includes("letter")) return { wmm: 215.9, hmm: 279.4 };
      if (lv.includes("legal")) return { wmm: 215.9, hmm: 355.6 };
    }
  }
  return null;
}

const PhotoBatchTool: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";
  const navigate = useNavigate();

  const [items, setItems] = useState<BatchItem[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [paperPreset, setPaperPreset] = useState<PaperPreset>("a4");
  const [customW, setCustomW] = useState(210);
  const [customH, setCustomH] = useState(297);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [fit, setFit] = useState<"cover" | "contain">("cover");
  const [marginPreset, setMarginPreset] = useState<number | null>(5);
  const [customMargins, setCustomMargins] = useState<MarginSpec>({ topMm: 5, rightMm: 5, bottomMm: 5, leftMm: 5 });
  const [colorMode, setColorMode] = useState<"color" | "bw">("color");
  const [paperType, setPaperType] = useState("glossy");
  const [copies, setCopies] = useState(1);

  const [settings, setSettings] = useState<ShopSettings>({ shopName: "", logoUrl: null });
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [defaultPrinter, setDefaultPrinter] = useState("");
  const [, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>({});

  const [building, setBuilding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showJobForm, setShowJobForm] = useState(false);
  const targets = useJobTargets();
  const dragIndexRef = useRef<number | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    storageService.getSettings().then((s) => {
      setSettings(s);
      setDefaultPrinter(s.defaultPrinterName || "");
      setPrinterDefaults(s.printerDefaults || {});
    }).catch(() => {});
    if (isElectron()) {
      getPrinters().then(setPrinters).catch(() => {});
    }
  }, []);

  // Handoff from the dashboard's NewJobDialog.
  useEffect(() => {
    const files = consumePhotoBatchHandoff();
    if (files && files.length) addFiles(files.map((f) => ({ file: f })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handoff from the dashboard's bulk "Send to Print Studio" action: job ids
  // only, so the files are fetched here and keep their source job for the
  // replace-source option on save.
  useEffect(() => {
    const raw = sessionStorage.getItem("ps_batch_jobs");
    if (!raw) return;
    sessionStorage.removeItem("ps_batch_jobs");
    let ids: string[] = [];
    try { ids = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(ids) || ids.length === 0) return;
    (async () => {
      try {
        const jobs = await storageService.getMetadata();
        const picked: { file: File; sourceJobId?: string; sourceCustomerName?: string }[] = [];
        for (const id of ids) {
          const job = jobs.find((j) => j.id === id);
          if (!job?.fileType?.startsWith("image/")) continue;
          const res = await fetch(`/api/files/public/${job.id}`);
          if (!res.ok) continue;
          const blob = await res.blob();
          picked.push({
            file: new File([blob], job.fileName, { type: job.fileType }),
            sourceJobId: job.id,
            sourceCustomerName: job.customerName?.trim() || undefined,
          });
        }
        if (picked.length) addFiles(picked);
      } catch (e) {
        toast({
          title: isRtl ? "تعذر تحميل الصور المحددة" : "Could not load the selected photos",
          description: errorMessage(e),
          variant: "destructive",
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paperTypes: PaperType[] =
    settings.paperTypes && settings.paperTypes.length > 0
      ? settings.paperTypes
      : [
          { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: settings.pricing?.colorPerPage || 30, blackWhitePerPage: settings.pricing?.blackWhitePerPage || 15 },
          { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: settings.pricing?.glossyPerPage || 50, blackWhitePerPage: settings.pricing?.glossyPerPage || 50 },
          { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: settings.pricing?.cardboardPerPage || 40, blackWhitePerPage: settings.pricing?.cardboardPerPage || 40 },
        ];

  const pageSpec = useMemo<PageSpec>(() => {
    let wmm = PAPER_PRESETS_MM.a4.w;
    let hmm = PAPER_PRESETS_MM.a4.h;
    if (paperPreset === "a3") {
      wmm = PAPER_PRESETS_MM.a3.w;
      hmm = PAPER_PRESETS_MM.a3.h;
    } else if (paperPreset === "match") {
      const info = printers.find((p) => p.name === defaultPrinter || p.isDefault) || printers[0];
      const parsed = parsePrinterPageSize(info);
      if (parsed) {
        wmm = parsed.wmm;
        hmm = parsed.hmm;
      }
    } else if (paperPreset === "custom") {
      wmm = Math.max(10, customW || 210);
      hmm = Math.max(10, customH || 297);
    }
    if (orientation === "landscape") return { widthPt: mmToPt(hmm), heightPt: mmToPt(wmm) };
    return { widthPt: mmToPt(wmm), heightPt: mmToPt(hmm) };
  }, [paperPreset, customW, customH, orientation, printers, defaultPrinter]);

  const margins = useMemo<MarginSpec>(() => {
    if (marginPreset !== null) {
      return { topMm: marginPreset, rightMm: marginPreset, bottomMm: marginPreset, leftMm: marginPreset };
    }
    return customMargins;
  }, [marginPreset, customMargins]);

  const layoutInputs = useMemo<LayoutItem[]>(
    () =>
      items.map((it) => ({
        id: it.id,
        bitmap: it.bitmap || undefined,
        naturalWidth: it.naturalWidth,
        naturalHeight: it.naturalHeight,
        rotateQuarterTurns: it.rotateQuarterTurns,
        objectFit: it.objectFit ?? undefined,
      })),
    [items],
  );

  const pages = useMemo<LaidOutPage[]>(
    () =>
      layoutBatch(layoutInputs, {
        page: pageSpec,
        margins,
        fit,
        autoRotate: orientation === "auto",
        background: "#ffffff",
        copies,
      }),
    [layoutInputs, pageSpec, margins, fit, orientation, copies],
  );

  const addFiles = useCallback(async (files: { file: File; sourceJobId?: string; sourceCustomerName?: string }[]) => {
    const incoming: BatchItem[] = files
      .filter((f) => f.file.type.startsWith("image/"))
      .map((f) => ({
        id: crypto.randomUUID(),
        file: f.file,
        sourceJobId: f.sourceJobId,
        sourceCustomerName: f.sourceCustomerName,
        bitmap: null,
        naturalWidth: 0,
        naturalHeight: 0,
        rotateQuarterTurns: 0 as const,
        objectFit: null,
      }));
    if (incoming.length === 0) {
      toast({ title: isRtl ? "الرجاء اختيار ملفات صور" : "Please pick image files", variant: "destructive" });
      return;
    }
    setItems((prev) => [...prev, ...incoming]);
    for (const it of incoming) {
      try {
        const { bitmap, width, height } = await decodeImageToBitmap(it.file);
        it.bitmap = bitmap;
        it.naturalWidth = width;
        it.naturalHeight = height;
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, bitmap, naturalWidth: width, naturalHeight: height, error: undefined } : p)));
      } catch (e) {
        it.error = errorMessage(e) || "Failed to decode";
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, error: it.error } : p)));
      }
    }
  }, [isRtl]);

  const onPickerAdd = useCallback((picked: PickedPhoto[]) => {
    addFiles(
      picked.map((p) => ({
        file: p.file,
        sourceJobId: p.job.id,
        sourceCustomerName: p.job.customerName?.trim() || undefined,
      })),
    );
  }, [addFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) addFiles(files.map((f) => ({ file: f })));
  }, [addFiles]);

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const move = useCallback((from: number, to: number) => {
    setItems((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [movedItem] = next.splice(from, 1);
      next.splice(to, 0, movedItem);
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const totalMB = items.reduce((sum, it) => sum + it.file.size, 0) / (1024 * 1024);
  const decodedCount = items.filter((it) => it.bitmap).length;
  const failedItems = items.filter((it) => it.error);
  const allDecoded = items.length > 0 && decodedCount === items.length && failedItems.length === 0;

  // Per-photo DPI from the layout, for the low-res badge.
  const dpiByPhoto = useMemo(() => {
    const map: Record<string, number> = {};
    for (const page of pages) {
      const it = layoutInputs.find((x) => x.id === page.photoId);
      if (it) map[page.photoId] = estimateDpi(it, page);
    }
    return map;
  }, [pages, layoutInputs]);

  // Live price preview.
  const paper = paperTypes.find((pt) => pt.id === paperType);
  const perPageRate = paper ? (colorMode === "bw" ? paper.blackWhitePerPage : paper.colorPerPage) : 0;
  const sheetCount = (items.length - failedItems.length) * copies;
  const price = perPageRate * sheetCount;
  const currency = settings.currency || "DZD";

  const buildPdf = useCallback(async (): Promise<Blob | null> => {
    if (items.length === 0) {
      toast({ title: isRtl ? "أضف صورة واحدة على الأقل" : "Add at least one photo", variant: "destructive" });
      return null;
    }
    if (failedItems.length > 0) {
      toast({
        title: isRtl ? "تعذر تحميل بعض الصور" : "Some photos failed to load",
        description: failedItems[0].error,
        variant: "destructive",
      });
      return null;
    }
    if (building) return null;
    setBuilding(true);
    try {
      const imageMap = new Map(items.map((it) => [it.id, it.bitmap!]));
      return await buildPhotoPdf(pages, imageMap, copies);
    } catch (e) {
      toast({ title: isRtl ? "فشل إنشاء الملف" : "Failed to build PDF", description: errorMessage(e), variant: "destructive" });
      return null;
    } finally {
      setBuilding(false);
    }
  }, [items, failedItems, building, pages, copies, isRtl]);

  const handlePrint = async () => {
    const blob = await buildPdf();
    if (!blob) return;
    if (!isElectron()) {
      window.open(URL.createObjectURL(blob), "_blank");
      return;
    }
    setPrinting(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await printData({
        data: bytes,
        fileType: "application/pdf",
        printerName: defaultPrinter || undefined,
        silent: true,
        options: {
          duplexMode: "simplex",
          color: colorMode === "color",
          copies: 1, // copies are baked into the PDF — never double-multiply
          collate: true,
          landscape: false,
        },
      });
      if (result.cancelled) toast({ title: isRtl ? "تم إلغاء الطباعة" : "Print cancelled" });
      else if (result.ok) toast({ title: isRtl ? "تم إرسال المهمة إلى الطابعة" : "Sent to printer", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل الطباعة" : "Print failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  // Photos pulled in from existing jobs — those jobs can be replaced by the
  // laid-out PDF on save.
  const sourceJobIds = useMemo(
    () => Array.from(new Set(items.map((it) => it.sourceJobId).filter(Boolean) as string[])),
    [items],
  );

  const handleSaveAsJob = async () => {
    const blob = await buildPdf();
    if (!blob) return;
    const customers = items.filter((it) => it.sourceCustomerName).map((it) => it.sourceCustomerName);
    const allSame = customers.length === items.length && new Set(customers).size === 1;
    const jobs = await targets.refresh();
    const sourceJob = sourceJobIds.length > 0 ? jobs.find((j) => j.id === sourceJobIds[0]) : null;
    targets.reset(
      sourceJob && allSame ? { job: sourceJob } : { name: allSame ? customers[0]! : "" },
    );
    setShowJobForm(true);
  };

  const submitJob = async () => {
    if (!targets.targetJob && !targets.name.trim()) return;
    const blob = await buildPdf();
    if (!blob) return;
    setBuilding(true);
    try {
      const file = new File([blob], "photos.pdf", { type: "application/pdf" });
      const result = await targets.save({
        file,
        preferences: {
          colorMode: colorMode === "bw" ? "blackWhite" : "color",
          copies: 1, // baked into the PDF
          paperType,
        },
        pageCount: pages.length,
        sourceJobIds,
        source: "admin",
      });
      setShowJobForm(false);
      toast({
        title: result.replaced
          ? isRtl ? "تم تحديث المهمة" : "Job updated"
          : isRtl ? "تم حفظ المهمة" : "Job saved",
        variant: "success",
      });
      navigate("/admin/dashboard");
    } catch (e) {
      toast({ title: isRtl ? "فشل حفظ المهمة" : "Failed to save job", description: errorMessage(e), variant: "destructive" });
    } finally {
      setBuilding(false);
    }
  };

  const drawPreview = (canvas: HTMLCanvasElement | null, page: LaidOutPage, item: BatchItem) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scale = Math.min(200 / page.pageWidthPt, 260 / page.pageHeightPt);
    canvas.width = Math.max(1, Math.round(page.pageWidthPt * scale));
    canvas.height = Math.max(1, Math.round(page.pageHeightPt * scale));
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, page.pageWidthPt, page.pageHeightPt);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, page.pageWidthPt, page.pageHeightPt);
    const clip = page.draw.clipRect!;
    if (!item.bitmap) {
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
      ctx.restore();
      return;
    }
    const drawSrc = page.draw.rotationDeg ? rotateQuarterTurnsToCanvas(item.bitmap, page.draw.rotationDeg / 90) : item.bitmap;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    if (page.draw.sourceCropRect) {
      const { sx, sy, sw, sh } = page.draw.sourceCropRect;
      ctx.drawImage(drawSrc, sx, sy, sw, sh, clip.x, clip.y, clip.w, clip.h);
    } else {
      const s = Math.min(clip.w / drawSrc.width, clip.h / drawSrc.height);
      const rw = drawSrc.width * s;
      const rh = drawSrc.height * s;
      ctx.fillStyle = page.draw.background;
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
      ctx.drawImage(drawSrc, clip.x + (clip.w - rw) / 2, clip.y + (clip.h - rh) / 2, rw, rh);
    }
    ctx.restore();
    ctx.restore();
  };

  const marginButtons: { mm: number; label: string }[] = [
    { mm: 0, label: t("borderless") },
    { mm: 3, label: "3mm" },
    { mm: 5, label: "5mm" },
    { mm: 10, label: "10mm" },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Controls */}
      <div className="lg:col-span-1 space-y-4">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("addPhotos")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => setShowPicker(true)}>
              {t("fromCustomer")}
            </Button>
            <div
              role="button"
              tabIndex={0}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => photoInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  photoInputRef.current?.click();
                }
              }}
              className="border-2 border-dashed border-input rounded-xl p-4 text-center cursor-pointer hover:border-primary/50 transition"
            >
              <Icon name="cloud-upload" className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
              <span className="text-xs text-muted-foreground">{t("dropPhotosHere")}</span>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) addFiles(files.map((f) => ({ file: f })));
                  e.target.value = "";
                }}
              />
            </div>
            {items.length > 0 && (
              <p className="text-xs text-muted-foreground text-center">
                {items.length} {t("photosCount")} &middot; {totalMB.toFixed(1)} MB
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("paperSize")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex flex-wrap gap-1">
              {([
                ["a4", "A4"],
                ["a3", "A3"],
                ["match", t("matchPrinter")],
                ["custom", t("customSize")],
              ] as [PaperPreset, string][]).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPaperPreset(v)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                    paperPreset === v ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {paperPreset === "custom" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">{isRtl ? "العرض (مم)" : "Width (mm)"}</Label>
                  <Input type="number" min={10} value={customW} onChange={(e) => setCustomW(Number(e.target.value) || 210)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{isRtl ? "الارتفاع (مم)" : "Height (mm)"}</Label>
                  <Input type="number" min={10} value={customH} onChange={(e) => setCustomH(Number(e.target.value) || 297)} />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">{isRtl ? "اتجاه الصفحة" : "Page orientation"}</Label>
              <Select value={orientation} onValueChange={(v) => setOrientation(v as Orientation)}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("orientationAuto")}</SelectItem>
                  <SelectItem value="portrait">{t("orientationPortrait")}</SelectItem>
                  <SelectItem value="landscape">{t("orientationLandscape")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("orientationNote")}</p>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("fillMode")}</Label>
              <div className="flex gap-1">
                {([
                  ["cover", t("fillCover")],
                  ["contain", t("fitContain")],
                ] as ["cover" | "contain", string][]).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setFit(v)}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                      fit === v ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("margins")}</Label>
              <div className="flex flex-wrap gap-1">
                {marginButtons.map((m) => (
                  <button
                    key={m.mm}
                    type="button"
                    onClick={() => setMarginPreset(m.mm)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                      marginPreset === m.mm ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setMarginPreset(null)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                    marginPreset === null ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t("marginCustom")}
                </button>
              </div>
              {marginPreset === null && (
                <div className="grid grid-cols-4 gap-2 mt-1">
                  {(["topMm", "rightMm", "bottomMm", "leftMm"] as const).map((key) => (
                    <div key={key} className="space-y-0.5">
                      <Label className="text-xs text-muted-foreground">{key.replace("Mm", "")}</Label>
                      <Input
                        type="number"
                        min={0}
                        value={customMargins[key]}
                        onChange={(e) => setCustomMargins((prev) => ({ ...prev, [key]: Math.max(0, Number(e.target.value) || 0) }))}
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
              {marginPreset === 0 && (
                <p className="text-xs text-muted-foreground mt-1">{t("borderlessHint")}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("colorMode")}</Label>
              <div className="flex gap-1">
                {([
                  ["color", t("color")],
                  ["bw", t("bw")],
                ] as ["color" | "bw", string][]).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setColorMode(v)}
                    className={`flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                      colorMode === v ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("paperType")}</Label>
              <Select value={paperType} onValueChange={setPaperType}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {paperTypes.map((pt) => (
                    <SelectItem key={pt.id} value={pt.id}>
                      {isRtl ? pt.nameAr : pt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("copies")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={copies}
                onChange={(e) => setCopies(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                className="h-8 text-xs"
              />
            </div>

            <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2 text-xs text-green-800 dark:text-green-100">
              {t("pricePreview")}: <span className="font-bold">{sheetCount} {t("pages")}</span> &middot;{" "}
              {isRtl ? paper?.nameAr : paper?.name} {colorMode === "bw" ? t("bw") : t("color")} &middot;{" "}
              <span className="font-bold">{formatPrice(price, currency)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button disabled={!allDecoded || building || printing} onClick={handlePrint}>
                {printing || building ? "..." : t("printNow")}
              </Button>
              <Button disabled={!allDecoded || building} variant="outline" onClick={handleSaveAsJob}>
                {building ? "..." : t("saveAsJob")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Preview grid */}
      <div className="lg:col-span-2">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">
              {t("preview")} &middot; {items.length} {t("pages")}
            </CardTitle>
            {items.length > 0 && (
              <Button variant="ghost" size="sm" className="text-xs text-destructive h-auto px-2 py-1" onClick={() => setItems([])}>
                {t("clearAll")}
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {items.length === 0 ? (
              <div className="flex items-center justify-center h-[300px] bg-muted/30 rounded-xl text-muted-foreground text-sm">{t("noPhotos")}</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {pages.map((page, i) => {
                  const item = items.find((it) => it.id === page.photoId)!;
                  const dpi = dpiByPhoto[page.photoId];
                  const lowRes = !!item.bitmap && dpi > 0 && dpi < 150;
                  return (
                    <div
                      key={page.photoId}
                      role="listitem"
                      draggable
                      onDragStart={() => { dragIndexRef.current = i; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const from = dragIndexRef.current; if (from !== null && from !== i) move(from, i); dragIndexRef.current = null; }}
                      className="rounded-xl border border-border bg-card p-2 cursor-grab active:cursor-grabbing"
                    >
                      <div className="relative">
                        <canvas ref={(el) => drawPreview(el, page, item)} className="w-full h-auto rounded-lg border border-border" />
                        {item.error && (
                          <div className="absolute inset-0 flex items-center justify-center bg-red-50/90 dark:bg-red-900/80 rounded-lg text-xs text-red-700 dark:text-red-200 p-2 text-center">
                            {item.error}
                          </div>
                        )}
                        {lowRes && (
                          <span
                            className="absolute top-1.5 left-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold"
                            title={isRtl ? `دقة منخفضة — قد تبدو الصورة مشوشة (~${Math.round(dpi)} DPI)` : `Low resolution — may look pixelated at this size (~${Math.round(dpi)} DPI)`}
                          >
                            !
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1.5">
                        <div className="flex flex-col me-auto">
                          <button
                            className="text-gray-400 hover:text-foreground p-0.5"
                            title={isRtl ? "لأعلى" : "Move up"}
                            onClick={() => move(i, i - 1)}
                          >
                            ▲
                          </button>
                          <button
                            className="text-gray-400 hover:text-foreground p-0.5"
                            title={isRtl ? "لأسفل" : "Move down"}
                            onClick={() => move(i, i + 1)}
                          >
                            ▼
                          </button>
                        </div>
                        <button
                          className="p-1 rounded-lg text-gray-400 hover:text-foreground hover:bg-muted"
                          title={t("rotate90")}
                          onClick={() => updateItem(page.photoId, { rotateQuarterTurns: ((item.rotateQuarterTurns + 1) % 4) as 0 | 1 | 2 | 3 })}
                         aria-label={t("rotate90")}>
                          <Icon name="refresh" className="w-4 h-4" />
                        </button>
                        <button
                          className="p-1 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted"
                          title={t("fillMode")}
                          onClick={() => updateItem(page.photoId, { objectFit: (item.objectFit ?? fit) === "cover" ? "contain" : "cover" })}
                        >
                          {(item.objectFit ?? fit) === "cover" ? t("fillCover") : t("fitContain")}
                        </button>
                        <button
                          className="p-1 ms-auto rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                          title={t("remove")}
                          onClick={() => removeItem(page.photoId)}
                         aria-label={t("remove")}>
                          <Icon name="x" className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground truncate" title={item.file.name}>
                        {item.file.name}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <PhotoSourceModal isOpen={showPicker} onClose={() => setShowPicker(false)} onAdd={onPickerAdd} />

      <Dialog open={showJobForm} onOpenChange={setShowJobForm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("saveAsJob")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pe-1">
            <JobTargetPicker
              targets={targets}
              isRtl={isRtl}
              sourceJobCount={sourceJobIds.length}
              sourceLabel={isRtl ? "مهمة مصدر" : "source job(s)"}
            />
            {!targets.targetJob && (
              <div className="space-y-1.5">
                <Label>{t("studioNotes")}</Label>
                <Input value={targets.notes} onChange={(e) => targets.setNotes(e.target.value)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowJobForm(false)}>{t("studioCancel")}</Button>
            <Button disabled={(!targets.targetJob && !targets.name.trim()) || building} onClick={submitJob}>
              {building
                ? t("uploading")
                : targets.targetJob
                  ? isRtl ? "استبدال الملف" : "Replace file"
                  : t("addJob")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PhotoBatchTool;
