import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { PageSpec, MarginSpec, LaidOutPage, PhotoItem as LayoutItem, PageGroup, PlacementOverride } from "../lib/photoLayout";
import { layoutGroups, estimateDpi, computePrintableRect, mmToPt, MIN_PLACEMENT_PT } from "../lib/photoLayout";
import { buildPhotoPdf } from "../lib/photoPdf";
import { drawPlacements } from "../lib/photoRender";
import { decodeImageToBitmap } from "../lib/imageNormalize";
import { isElectron, printData, getPrinters, PrinterInfo } from "../lib/electronPrint";
import { storageService } from "../services/storageService";
import { useLanguage } from "../lib/useLanguage";
import { useStudioSnapshot, useStudioRestore } from "../lib/studioPersist";
import { toast } from "../components/ui/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import PhotoSourceModal, { PickedPhoto } from "../components/PhotoSourceModal";
import ImageSearchModal from "../components/ImageSearchModal";
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

// What survives an app restart (unless the shop turned Print Studio
// persistence off in Settings). Bitmaps are left out and re-decoded from the stored File on restore.
interface PhotoSnapshot {
  items: {
    id: string;
    file: File;
    sourceJobId?: string;
    sourceCustomerName?: string;
    rotateQuarterTurns: 0 | 1 | 2 | 3;
    objectFit: "cover" | "contain" | null;
  }[];
  groups: PageGroup[];
  overrides: Record<string, PlacementOverride>;
  paperPreset: PaperPreset;
  customW: number;
  customH: number;
  orientation: Orientation;
  fit: "cover" | "contain";
  marginPreset: number | null;
  customMargins: MarginSpec;
  colorMode: "color" | "bw";
  paperType: string;
  copies: number;
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

function defaultGroups(itemIds: string[]): PageGroup[] {
  return itemIds.map((id) => ({ id, itemIds: [id] }));
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

interface DragState {
  itemId: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  startRect: { xPt: number; yPt: number; wPt: number; hPt: number };
  pageWidthPt: number;
  pageHeightPt: number;
  scale: number;
}

const PhotoBatchTool: React.FC = () => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";
  const navigate = useNavigate();

  const [items, setItems] = useState<BatchItem[]>([]);
  const [groups, setGroups] = useState<PageGroup[]>([]);
  const [overrides, setOverrides] = useState<Record<string, PlacementOverride>>({});
  const [combineSelection, setCombineSelection] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [showImageSearch, setShowImageSearch] = useState(false);
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
  // False until the saved-across-restarts snapshot (if any) has been applied.
  const [restored, setRestored] = useState(false);
  // Read on the first render: the handoff effect above clears this key before
  // the async restore resolves, so checking it later is too late.
  const handoffPendingRef = useRef(!!sessionStorage.getItem("ps_batch_jobs"));
  const dragIndexRef = useRef<number | null>(null);
  const placementDragRef = useRef<DragState | null>(null);
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

  const itemsById = useMemo<Record<string, LayoutItem>>(
    () =>
      Object.fromEntries(
        items.map((it) => [
          it.id,
          {
            id: it.id,
            bitmap: it.bitmap || undefined,
            naturalWidth: it.naturalWidth,
            naturalHeight: it.naturalHeight,
            rotateQuarterTurns: it.rotateQuarterTurns,
            objectFit: it.objectFit ?? undefined,
          },
        ]),
      ),
    [items],
  );

  const itemsMap = useMemo(() => new Map(Object.entries(itemsById)), [itemsById]);

  const pages = useMemo<LaidOutPage[]>(
    () =>
      layoutGroups(groups, itemsById, overrides, {
        page: pageSpec,
        margins,
        fit,
        autoRotate: orientation === "auto",
        background: "#ffffff",
        copies,
      }),
    [groups, itemsById, overrides, pageSpec, margins, fit, orientation, copies],
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
    setGroups((prev) => [...prev, ...defaultGroups(incoming.map((it) => it.id))]);
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

  // Re-decode a restored batch: the File survives the restart, the ImageBitmap
  // does not.
  const restoreItems = useCallback(async (saved: PhotoSnapshot["items"]) => {
    const rebuilt: BatchItem[] = saved.map((it) => ({
      id: it.id,
      file: it.file,
      sourceJobId: it.sourceJobId,
      sourceCustomerName: it.sourceCustomerName,
      bitmap: null,
      naturalWidth: 0,
      naturalHeight: 0,
      rotateQuarterTurns: it.rotateQuarterTurns,
      objectFit: it.objectFit,
    }));
    setItems(rebuilt);
    for (const it of rebuilt) {
      try {
        const { bitmap, width, height } = await decodeImageToBitmap(it.file);
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, bitmap, naturalWidth: width, naturalHeight: height, error: undefined } : p)));
      } catch (e) {
        const message = errorMessage(e) || "Failed to decode";
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, error: message } : p)));
      }
    }
  }, []);

  useStudioRestore<PhotoSnapshot>(
    "photos",
    async (snap) => {
      // An explicit handoff from the dashboard wins over the previous run.
      if (handoffPendingRef.current) return;
      setPaperPreset(snap.paperPreset);
      setCustomW(snap.customW);
      setCustomH(snap.customH);
      setOrientation(snap.orientation);
      setFit(snap.fit);
      setMarginPreset(snap.marginPreset);
      setCustomMargins(snap.customMargins);
      setColorMode(snap.colorMode);
      setPaperType(snap.paperType);
      setCopies(snap.copies);
      if (snap.items?.length) {
        await restoreItems(snap.items);
        setGroups(snap.groups?.length ? snap.groups : defaultGroups(snap.items.map((it) => it.id)));
        setOverrides(snap.overrides || {});
      }
    },
    () => setRestored(true),
  );

  useStudioSnapshot<PhotoSnapshot>(
    "photos",
    items.length > 0
      ? {
          items: items.map((it) => ({
            id: it.id,
            file: it.file,
            sourceJobId: it.sourceJobId,
            sourceCustomerName: it.sourceCustomerName,
            rotateQuarterTurns: it.rotateQuarterTurns,
            objectFit: it.objectFit,
          })),
          groups,
          overrides,
          paperPreset,
          customW,
          customH,
          orientation,
          fit,
          marginPreset,
          customMargins,
          colorMode,
          paperType,
          copies,
        }
      : null,
    restored,
  );

  const onPickerAdd = useCallback((picked: PickedPhoto[]) => {
    addFiles(
      picked.map((p) => ({
        file: p.file,
        sourceJobId: p.job.id,
        sourceCustomerName: p.job.customerName?.trim() || undefined,
      })),
    );
  }, [addFiles]);

  const onSearchAdd = useCallback((files: File[]) => {
    addFiles(files.map((file) => ({ file })));
  }, [addFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) addFiles(files.map((f) => ({ file: f })));
  }, [addFiles]);

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const moveGroup = useCallback((from: number, to: number) => {
    setGroups((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [movedGroup] = next.splice(from, 1);
      next.splice(to, 0, movedGroup);
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
    setGroups((prev) => prev.map((g) => ({ ...g, itemIds: g.itemIds.filter((x) => x !== id) })).filter((g) => g.itemIds.length > 0));
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCombineSelection((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleGroupSelection = useCallback((group: PageGroup) => {
    setCombineSelection((prev) => {
      const next = new Set(prev);
      const allSelected = group.itemIds.every((id) => next.has(id));
      if (allSelected) group.itemIds.forEach((id) => next.delete(id));
      else group.itemIds.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const combineSelected = useCallback(() => {
    if (combineSelection.size < 2) return;
    setGroups((prev) => {
      const selectedIds = combineSelection;
      const firstIndex = prev.findIndex((g) => g.itemIds.some((id) => selectedIds.has(id)));
      const allSelectedInOrder = prev.flatMap((g) => g.itemIds).filter((id) => selectedIds.has(id));
      const rest = prev
        .map((g) => ({ ...g, itemIds: g.itemIds.filter((id) => !selectedIds.has(id)) }))
        .filter((g) => g.itemIds.length > 0);
      const insertAt = prev.slice(0, firstIndex).filter((g) => g.itemIds.some((id) => !selectedIds.has(id))).length;
      const newGroup: PageGroup = { id: crypto.randomUUID(), itemIds: allSelectedInOrder };
      const next = [...rest];
      next.splice(insertAt, 0, newGroup);
      return next;
    });
    setOverrides((prev) => {
      const next = { ...prev };
      combineSelection.forEach((id) => delete next[id]);
      return next;
    });
    setCombineSelection(new Set());
  }, [combineSelection]);

  const splitGroup = useCallback((groupId: string) => {
    setGroups((prev) => {
      const idx = prev.findIndex((g) => g.id === groupId);
      if (idx === -1) return prev;
      const group = prev[idx];
      if (group.itemIds.length <= 1) return prev;
      const singles = group.itemIds.map((id) => ({ id: crypto.randomUUID(), itemIds: [id] }));
      const next = [...prev];
      next.splice(idx, 1, ...singles);
      return next;
    });
    setOverrides((prev) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return prev;
      const next = { ...prev };
      group.itemIds.forEach((id) => delete next[id]);
      return next;
    });
  }, [groups]);

  const snapFullPage = useCallback((itemId: string, printable: { x: number; y: number; w: number; h: number }) => {
    setOverrides((prev) => ({ ...prev, [itemId]: { xPt: printable.x, yPt: printable.y, wPt: printable.w, hPt: printable.h } }));
  }, []);

  const beginPlacementDrag = (
    e: React.PointerEvent,
    itemId: string,
    mode: "move" | "resize",
    rect: { xPt: number; yPt: number; wPt: number; hPt: number },
    pageWidthPt: number,
    pageHeightPt: number,
    scale: number,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignored */ }
    placementDragRef.current = { itemId, mode, startX: e.clientX, startY: e.clientY, startRect: { ...rect }, pageWidthPt, pageHeightPt, scale };
  };

  const onPlacementDragMove = (e: React.PointerEvent) => {
    const d = placementDragRef.current;
    if (!d) return;
    e.preventDefault();
    const dxPt = (e.clientX - d.startX) / d.scale;
    const dyPt = (e.clientY - d.startY) / d.scale;
    if (d.mode === "move") {
      const xPt = clamp(d.startRect.xPt + dxPt, 0, Math.max(0, d.pageWidthPt - d.startRect.wPt));
      const yPt = clamp(d.startRect.yPt + dyPt, 0, Math.max(0, d.pageHeightPt - d.startRect.hPt));
      setOverrides((prev) => ({ ...prev, [d.itemId]: { ...prev[d.itemId], xPt, yPt } }));
    } else {
      const wPt = clamp(d.startRect.wPt + dxPt, MIN_PLACEMENT_PT, Math.max(MIN_PLACEMENT_PT, d.pageWidthPt - d.startRect.xPt));
      const hPt = clamp(d.startRect.hPt + dyPt, MIN_PLACEMENT_PT, Math.max(MIN_PLACEMENT_PT, d.pageHeightPt - d.startRect.yPt));
      setOverrides((prev) => ({ ...prev, [d.itemId]: { ...prev[d.itemId], xPt: d.startRect.xPt, yPt: d.startRect.yPt, wPt, hPt } }));
    }
  };

  const endPlacementDrag = () => {
    placementDragRef.current = null;
  };

  const failedItems = items.filter((it) => it.error);
  const failedIds = useMemo(() => new Set(failedItems.map((it) => it.id)), [failedItems]);
  const totalMB = items.reduce((sum, it) => sum + it.file.size, 0) / (1024 * 1024);
  const decodedCount = items.filter((it) => it.bitmap).length;
  const allDecoded = items.length > 0 && decodedCount === items.length && failedItems.length === 0;

  // Per-photo DPI from the layout, for the low-res badge.
  const dpiByPhoto = useMemo(() => {
    const map: Record<string, number> = {};
    for (const page of pages) {
      for (const placement of page.placements) {
        const it = itemsById[placement.photoId];
        if (it) map[placement.photoId] = estimateDpi(it, placement);
      }
    }
    return map;
  }, [pages, itemsById]);

  // Live price preview — billed per physical sheet, not per photo, since a
  // page can now hold several combined images.
  const paper = paperTypes.find((pt) => pt.id === paperType);
  const perPageRate = paper ? (colorMode === "bw" ? paper.blackWhitePerPage : paper.colorPerPage) : 0;
  const billablePages = groups.filter((g) => g.itemIds.some((id) => !failedIds.has(id))).length;
  const sheetCount = billablePages * copies;
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
      const layoutItemsMap = new Map(items.map((it) => [it.id, itemsById[it.id]]));
      const imageMap = new Map(items.map((it) => [it.id, it.bitmap!]));
      return await buildPhotoPdf(pages, layoutItemsMap, imageMap, copies);
    } catch (e) {
      toast({ title: isRtl ? "فشل إنشاء الملف" : "Failed to build PDF", description: errorMessage(e), variant: "destructive" });
      return null;
    } finally {
      setBuilding(false);
    }
  }, [items, failedItems, building, pages, itemsById, copies, isRtl]);

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

  const drawGroupPreview = (canvas: HTMLCanvasElement | null, page: LaidOutPage, w: number, h: number, scale: number) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    const sourcesById = new Map(items.map((it) => [it.id, it.bitmap || undefined]));
    drawPlacements(ctx, page, itemsMap, sourcesById, scale);
  };

  const marginButtons: { mm: number; label: string }[] = [
    { mm: 0, label: t("borderless") },
    { mm: 3, label: "3mm" },
    { mm: 5, label: "5mm" },
    { mm: 10, label: "10mm" },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Controls */}
      <div className="lg:col-span-1 space-y-4">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">{t("addPhotos")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowPicker(true)}>
                {t("fromCustomer")}
              </Button>
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowImageSearch(true)}>
                {t("searchImages")}
              </Button>
            </div>
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
      <div className="lg:col-span-3">
        <Card className="shadow-none">
          <CardHeader className="p-4 pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">
              {t("preview")} &middot; {groups.length} {t("pages")}
            </CardTitle>
            <div className="flex items-center gap-2">
              {combineSelection.size >= 2 && (
                <Button variant="outline" size="sm" className="text-xs h-auto px-2 py-1" onClick={combineSelected}>
                  {t("combineIntoPage")} ({combineSelection.size})
                </Button>
              )}
              {items.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-destructive h-auto px-2 py-1"
                  onClick={() => { setItems([]); setGroups([]); setOverrides({}); setCombineSelection(new Set()); }}
                >
                  {t("clearAll")}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {groups.length === 0 ? (
              <div className="flex items-center justify-center h-[300px] bg-muted/30 rounded-xl text-muted-foreground text-sm">{t("noPhotos")}</div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                {groups.map((group, i) => {
                  const page = pages[i];
                  if (!page) return null;
                  const scale = Math.min(420 / page.pageWidthPt, 520 / page.pageHeightPt);
                  const canvasW = Math.max(1, Math.round(page.pageWidthPt * scale));
                  const canvasH = Math.max(1, Math.round(page.pageHeightPt * scale));
                  const printable = computePrintableRect(page.pageWidthPt, page.pageHeightPt, margins);
                  const groupSelected = group.itemIds.every((id) => combineSelection.has(id));
                  const names = group.itemIds.map((id) => items.find((it) => it.id === id)?.file.name).filter(Boolean).join(", ");

                  return (
                    <div
                      key={group.id}
                      role="listitem"
                      draggable
                      onDragStart={() => { dragIndexRef.current = i; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const from = dragIndexRef.current; if (from !== null && from !== i) moveGroup(from, i); dragIndexRef.current = null; }}
                      className="rounded-xl border border-border bg-card p-2"
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 cursor-pointer"
                          checked={groupSelected}
                          onChange={() => toggleGroupSelection(group)}
                          title={t("selectMode")}
                        />
                        {group.itemIds.length > 1 && (
                          <span className="text-xs text-muted-foreground">{group.itemIds.length}&times;</span>
                        )}
                        <div className="ms-auto flex items-center gap-0.5">
                          {group.itemIds.length > 1 && (
                            <button
                              className="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-muted"
                              onClick={() => splitGroup(group.id)}
                            >
                              {t("splitPage")}
                            </button>
                          )}
                          <button className="text-gray-400 hover:text-foreground p-0.5 cursor-grab active:cursor-grabbing" title={isRtl ? "لأعلى" : "Move up"} onClick={() => moveGroup(i, i - 1)}>▲</button>
                          <button className="text-gray-400 hover:text-foreground p-0.5" title={isRtl ? "لأسفل" : "Move down"} onClick={() => moveGroup(i, i + 1)}>▼</button>
                        </div>
                      </div>

                      <div
                        className="relative bg-white border border-border rounded-lg overflow-hidden mx-auto"
                        style={{ width: canvasW, height: canvasH }}
                      >
                        <canvas ref={(el) => drawGroupPreview(el, page, canvasW, canvasH, scale)} className="absolute inset-0" style={{ width: canvasW, height: canvasH }} />
                        {page.placements.map((placement) => {
                          const item = items.find((it) => it.id === placement.photoId);
                          if (!item) return null;
                          const dpi = dpiByPhoto[placement.photoId];
                          const lowRes = !!item.bitmap && dpi > 0 && dpi < 150;
                          const left = placement.xPt * scale;
                          const top = placement.yPt * scale;
                          const w = placement.wPt * scale;
                          const h = placement.hPt * scale;
                          return (
                            <div
                              key={placement.photoId}
                              className="absolute border border-dashed border-indigo-400/70 group/placement select-none"
                              style={{ left, top, width: w, height: h, touchAction: "none" }}
                              onPointerDown={(e) => beginPlacementDrag(e, placement.photoId, "move", { xPt: placement.xPt, yPt: placement.yPt, wPt: placement.wPt, hPt: placement.hPt }, page.pageWidthPt, page.pageHeightPt, scale)}
                              onPointerMove={onPlacementDragMove}
                              onPointerUp={endPlacementDrag}
                            >
                              {item.error && (
                                <div className="absolute inset-0 flex items-center justify-center bg-red-50/90 dark:bg-red-900/80 text-xs text-red-700 dark:text-red-200 p-1 text-center">
                                  {item.error}
                                </div>
                              )}
                              {lowRes && (
                                <span
                                  className="absolute top-0.5 start-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold"
                                  title={isRtl ? `دقة منخفضة (~${Math.round(dpi)} DPI)` : `Low resolution (~${Math.round(dpi)} DPI)`}
                                >
                                  !
                                </span>
                              )}
                              <div className="absolute -top-6 start-0 hidden group-hover/placement:flex items-center gap-0.5 bg-card border border-border rounded-md shadow px-1 py-0.5 z-10 whitespace-nowrap">
                                <button
                                  className="p-0.5 rounded text-gray-400 hover:text-foreground hover:bg-muted"
                                  title={t("rotate90")}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); updateItem(item.id, { rotateQuarterTurns: ((item.rotateQuarterTurns + 1) % 4) as 0 | 1 | 2 | 3 }); }}
                                >
                                  <Icon name="refresh" className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  className="p-0.5 rounded text-xs font-medium text-muted-foreground hover:bg-muted"
                                  title={t("fillMode")}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); updateItem(item.id, { objectFit: (item.objectFit ?? fit) === "cover" ? "contain" : "cover" }); }}
                                >
                                  {(item.objectFit ?? fit) === "cover" ? t("fillCover") : t("fitContain")}
                                </button>
                                <button
                                  className="p-0.5 rounded text-xs font-medium text-muted-foreground hover:bg-muted"
                                  title={t("fullPage")}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); snapFullPage(item.id, printable); }}
                                >
                                  {t("fullPage")}
                                </button>
                                <button
                                  className="p-0.5 rounded text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  title={t("remove")}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                                >
                                  <Icon name="x" className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div
                                className="absolute bottom-0 end-0 w-3 h-3 bg-indigo-500 cursor-se-resize opacity-0 group-hover/placement:opacity-100"
                                onPointerDown={(e) => beginPlacementDrag(e, placement.photoId, "resize", { xPt: placement.xPt, yPt: placement.yPt, wPt: placement.wPt, hPt: placement.hPt }, page.pageWidthPt, page.pageHeightPt, scale)}
                                onPointerMove={onPlacementDragMove}
                                onPointerUp={endPlacementDrag}
                              />
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate" title={names}>
                        {names}
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
      <ImageSearchModal isOpen={showImageSearch} onClose={() => setShowImageSearch(false)} onAdd={onSearchAdd} />

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
