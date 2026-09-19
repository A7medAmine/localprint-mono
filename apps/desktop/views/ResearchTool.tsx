import React, { useEffect, useMemo, useRef, useState } from "react";
import { Language, ResearchPaper, ResearchDocument, ResearchSection, ResearchLevel, ResearchLanguage, ResearchTypography, ResearchImageCandidate, ShopSettings } from "../types";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Icon, Spinner } from "../components/ui/icon";
import ConfirmDialog from "../components/ConfirmDialog";
import ResearchImagePickerDialog from "../components/ResearchImagePickerDialog";
import ResearchPrintDialog, { ResearchPrintOptions } from "../components/ResearchPrintDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { buildResearchHtml, buildResearchPlainText, estimatePageCount, debounce } from "../components/researchDocument";
import { isElectron, printData, renderHtmlPdf } from "../lib/electronPrint";
import { useStudioSnapshot, useStudioRestore } from "../lib/studioPersist";
import { readJsonPref, writeJsonPref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";

const downloadBlob = (bytes: Uint8Array, filename: string) => {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

interface ResearchToolProps {
  lang: Language;
}

const LEVELS: { id: ResearchLevel; ar: string; en: string }[] = [
  { id: "primary", ar: "ابتدائي", en: "Primary" },
  { id: "middle", ar: "متوسط", en: "Middle" },
  { id: "secondary", ar: "ثانوي", en: "Secondary" },
];

const LANGS: { id: ResearchLanguage; ar: string; en: string }[] = [
  { id: "ar", ar: "عربية", en: "Arabic" },
  { id: "fr", ar: "Français", en: "French" },
  { id: "en", ar: "English", en: "English" },
];

const FONT_FAMILIES: { id: ResearchTypography["fontFamily"]; ar: string; en: string }[] = [
  { id: "sans", ar: "بدون زخرفة", en: "Sans" },
  { id: "serif", ar: "مزخرف", en: "Serif" },
  { id: "naskh", ar: "نسخ", en: "Naskh" },
];

const MARGIN_PRESETS: { id: NonNullable<ResearchTypography["margin"]>; ar: string; en: string }[] = [
  { id: "none", ar: "بدون", en: "None" },
  { id: "narrow", ar: "ضيق", en: "Narrow" },
  { id: "default", ar: "افتراضي", en: "Default" },
  { id: "large", ar: "واسع", en: "Large" },
];

const IMAGE_SIZE_PRESETS: { id: NonNullable<ResearchTypography["imageSize"]>; ar: string; en: string }[] = [
  { id: "small", ar: "صغيرة", en: "Small" },
  { id: "default", ar: "افتراضي", en: "Default" },
  { id: "large", ar: "كبيرة", en: "Large" },
];

// Algerian curriculum subjects per school level (MEN). Secondary is the
// union across all streams (no stream selector exists in the draft form).
const SUBJECTS_BY_LEVEL: Record<ResearchLevel, string[]> = {
  primary: [
    "اللغة العربية",
    "الرياضيات",
    "اللغة الإنجليزية",
    "التربية الإسلامية",
    "التربية العلمية والتكنولوجية",
    "التاريخ والجغرافيا",
    "التربية الفنية",
    "التربية الموسيقية",
    "التربية البدنية والرياضية",
    "اللغة الفرنسية",
  ],
  middle: [
    "اللغة العربية",
    "الرياضيات",
    "اللغة الفرنسية",
    "اللغة الإنجليزية",
    "اللغة الأمازيغية",
    "علوم الطبيعة والحياة",
    "العلوم الفيزيائية والتكنولوجيا",
    "التاريخ والجغرافيا",
    "التربية الإسلامية",
    "التربية المدنية",
    "الإعلام الآلي",
    "التربية الفنية والموسيقية",
    "التربية البدنية والرياضية",
  ],
  secondary: [
    "اللغة العربية وآدابها",
    "الرياضيات",
    "اللغة الفرنسية",
    "اللغة الإنجليزية",
    "اللغة الأمازيغية",
    "لغة أجنبية ثالثة (إسبانية/ألمانية/إيطالية)",
    "العلوم الفيزيائية",
    "علوم الطبيعة والحياة",
    "الهندسة الميكانيكية",
    "الهندسة الكهربائية",
    "الهندسة المدنية",
    "هندسة الطرائق",
    "التسيير المحاسبي والمالي",
    "الاقتصاد والمناجمنت",
    "القانون",
    "الفلسفة",
    "التاريخ والجغرافيا",
    "التربية الإسلامية",
    "التربية المدنية",
    "الإعلام الآلي",
    "التربية البدنية والرياضية",
  ],
};
const OTHER_SUBJECT = "__other__";

interface DraftForm {
  topic: string;
  level: ResearchLevel;
  subject: string;
  language: ResearchLanguage;
  targetPages: number;
  includeSources: boolean;
  customInstructions: string;
}

const emptyDraft = (): DraftForm => ({
  topic: "",
  level: "middle",
  subject: "",
  language: "ar",
  targetPages: 4,
  includeSources: true,
  customInstructions: "",
});

function wordCount(text: string): number {
  return (text.trim().match(/\S+/g) || []).length;
}

function researchLengthLabel(pages: number, isRtl: boolean): string {
  if (pages < 1) return isRtl ? "فقرة قصيرة" : "Short paragraph";
  if (pages === 1) return isRtl ? "صفحة واحدة" : "1 page";
  const rounded = Number.isInteger(pages) ? pages : pages.toFixed(1);
  return isRtl ? `${rounded} صفحات` : `${rounded} pages`;
}

// Rewrites the auth-gated /api/research/:id/images/:imageId/file src's into
// data: URLs before handing the HTML to the preview iframe — a plain <img>
// there has no Authorization header (same reasoning as fetchCvPhotoDataUrl).
async function inlineResearchImages(html: string, paperId: string, imageIds: string[], cache: Map<string, string>): Promise<string> {
  let out = html;
  for (const imageId of imageIds) {
    const marker = `/api/research/${paperId}/images/${imageId}/file`;
    if (!out.includes(marker)) continue;
    let dataUrl = cache.get(imageId);
    if (!dataUrl) {
      const fetched = await storageService.fetchResearchImageDataUrl(paperId, imageId);
      if (!fetched) continue;
      dataUrl = fetched;
      cache.set(imageId, dataUrl);
    }
    out = out.split(marker).join(dataUrl);
  }
  return out;
}

const ResearchTool: React.FC<ResearchToolProps> = ({ lang }) => {
  const isRtl = lang === "ar";

  // ── Saved list ───────────────────────────────────────────────────────
  const [papers, setPapers] = useState<ResearchPaper[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<ResearchPaper | null>(null);

  // ── Creation form (unsaved draft — persisted across tool switches) ────
  const [draft, setDraft] = useState<DraftForm>(emptyDraft());
  const [coverOpen, setCoverOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [subjectHistory, setSubjectHistory] = useState<string[]>(() => readJsonPref("researchRecentSubjects", [] as string[]));
  const [restored, setRestored] = useState(false);

  // ── Generation ──────────────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  // ── Loaded / editing paper ─────────────────────────────────────────
  const [paperId, setPaperId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [doc, setDoc] = useState<ResearchDocument | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const loadedRef = useRef(false);

  // ── Preview ─────────────────────────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState("");
  const [pageCount, setPageCount] = useState<number | null>(null);
  const imageDataCache = useRef<Map<string, string>>(new Map());

  // ── Image picker ────────────────────────────────────────────────────
  const [picker, setPicker] = useState<{ sectionId: string | null; initialQuery: string } | null>(null);

  // ── Extend ("add sections") ────────────────────────────────────────
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendCount, setExtendCount] = useState(2);
  const [extending, setExtending] = useState(false);

  // ── Section reorder (native drag & drop, same pattern as PDFJobManager) ─
  const [dragId, setDragId] = useState<string | null>(null);

  // ── Print / export / copy-to-Word ──────────────────────────────────
  const [shopSettings, setShopSettings] = useState<ShopSettings | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [printSubmitting, setPrintSubmitting] = useState(false);

  const loadPapers = async (q?: string) => {
    try {
      setPapers(await storageService.getResearchPapers(q));
    } catch (err) {
      toast({ title: isRtl ? "فشل تحميل البحوث" : "Failed to load research papers", description: errorMessage(err), variant: "destructive" });
    } finally {
      setLoadingList(false);
    }
  };

  const coverDefaultsRef = useRef({ researchSchoolName: "", researchTeacherName: "", researchSchoolYear: "" });

  useEffect(() => {
    loadPapers();
    storageService.getResearchCoverDefaults().then((d) => {
      coverDefaultsRef.current = d;
    }).catch(() => {});
    storageService.getSettings().then(setShopSettings).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => loadPapers(search.trim() || undefined), 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Persist only the unsaved draft form state across tool switches — saved
  // papers already live server-side, so there is nothing else worth restoring.
  useStudioRestore<DraftForm>(
    "research",
    (snap) => setDraft(snap),
    () => setRestored(true),
  );
  useStudioSnapshot<DraftForm>("research", paperId ? null : draft, restored);

  // ── Generation ──────────────────────────────────────────────────────
  const startGenerate = async () => {
    const topic = draft.topic.trim();
    if (!topic) {
      toast({ title: isRtl ? "اكتب موضوع البحث أولاً" : "Type a topic first", variant: "destructive" });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setElapsedSec(0);
    timerRef.current = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    try {
      const paper = await storageService.generateResearchPaper(
        {
          topic,
          level: draft.level,
          subject: draft.subject.trim(),
          language: draft.language,
          targetPages: draft.targetPages,
          includeSources: draft.includeSources,
          customInstructions: draft.customInstructions.trim(),
        },
        controller.signal,
      );
      if (draft.subject.trim()) {
        const nextHistory = [draft.subject.trim(), ...subjectHistory.filter((s) => s !== draft.subject.trim())].slice(0, 10);
        setSubjectHistory(nextHistory);
        writeJsonPref("researchRecentSubjects", nextHistory);
      }
      openPaper(paper);
      setDraft(emptyDraft());
      loadPapers(search.trim() || undefined);
      toast({ title: isRtl ? "تم توليد البحث" : "Research paper generated", variant: "success" });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        toast({ title: isRtl ? "تم الإلغاء" : "Cancelled" });
      } else {
        toast({ title: isRtl ? "تعذّر التوليد" : "Generation failed", description: errorMessage(err), variant: "destructive" });
      }
    } finally {
      setGenerating(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      abortRef.current = null;
    }
  };

  const cancelGenerate = () => abortRef.current?.abort();

  // ── Load / open a paper ────────────────────────────────────────────
  const openPaper = (paper: ResearchPaper) => {
    loadedRef.current = false;
    setPaperId(paper.id);
    setTitle(paper.title);
    setDoc(paper.data);
    setSaveState("idle");
    // Skip the very next autosave tick — it would otherwise fire once with
    // the just-loaded data and race the server's own copy of it.
    setTimeout(() => { loadedRef.current = true; }, 0);
  };

  const openPaperById = async (row: ResearchPaper) => {
    try {
      const full = await storageService.getResearchPaper(row.id);
      openPaper(full);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر فتح البحث" : "Could not open the paper", description: errorMessage(err), variant: "destructive" });
    }
  };

  const startNew = () => {
    setPaperId(null);
    setTitle("");
    setDoc(null);
    loadedRef.current = false;
    setDraft((prev) => ({
      ...emptyDraft(),
      language: prev.language,
      level: prev.level,
    }));
  };

  // ── Autosave (PUT, debounced ~1s) ──────────────────────────────────
  useEffect(() => {
    if (!paperId || !doc || !loadedRef.current) return;
    setSaveState("saving");
    const handle = setTimeout(async () => {
      try {
        await storageService.updateResearchPaper(paperId, {
          title,
          subject: doc.subject,
          level: doc.level,
          language: doc.language,
          data: doc,
        });
        setSaveState("saved");
        setPapers((prev) => prev.map((p) => (p.id === paperId ? { ...p, title, subject: doc.subject, level: doc.level, language: doc.language } : p)));
      } catch (err) {
        setSaveState("idle");
        toast({ title: isRtl ? "فشل الحفظ التلقائي" : "Autosave failed", description: errorMessage(err), variant: "destructive" });
      }
    }, 1000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, doc, paperId]);

  // ── Live preview (debounced ~300ms) ────────────────────────────────
  const rebuildPreview = useMemo(
    () =>
      debounce(async (d: ResearchDocument, t: string, id: string) => {
        try {
          const html = await buildResearchHtml({ doc: d, title: t, paperId: id, inlineFonts: false });
          const inlined = await inlineResearchImages(html, id, d.images.map((i) => i.id), imageDataCache.current);
          setPreviewHtml(inlined);
        } catch {
          // A broken preview is not fatal — the editor and autosave keep working.
        }
      }, 300),
    [],
  );

  const rebuildPageCount = useMemo(
    () =>
      debounce(async (d: ResearchDocument, t: string, id: string) => {
        try {
          setPageCount(await estimatePageCount(d, t, id));
        } catch {
          /* keep the last known estimate on failure */
        }
      }, 300),
    [],
  );

  useEffect(() => {
    if (!doc || !paperId) {
      setPreviewHtml("");
      setPageCount(null);
      return;
    }
    rebuildPreview(doc, title, paperId);
    rebuildPageCount(doc, title, paperId);
  }, [doc, title, paperId, rebuildPreview, rebuildPageCount]);

  // ── Doc field helpers ───────────────────────────────────────────────
  const patchDoc = (patch: Partial<ResearchDocument>) => setDoc((prev) => (prev ? { ...prev, ...patch } : prev));

  const patchSection = (id: string, patch: Partial<ResearchSection>) =>
    setDoc((prev) => (prev ? { ...prev, sections: prev.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : prev));

  const removeSection = (id: string) =>
    setDoc((prev) => (prev ? { ...prev, sections: prev.sections.filter((s) => s.id !== id) } : prev));

  const moveSection = (fromId: string, toId: string) =>
    setDoc((prev) => {
      if (!prev) return prev;
      const list = [...prev.sections];
      const fromIdx = list.findIndex((s) => s.id === fromId);
      const toIdx = list.findIndex((s) => s.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      return { ...prev, sections: list };
    });

  const expandSection = async (section: ResearchSection) => {
    if (!paperId) return;
    const target = Math.min(2000, Math.max(150, wordCount(section.body) + 150));
    try {
      const updated = await storageService.expandResearchSection(paperId, section.id, target);
      setDoc(updated.data);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر التوسيع" : "Could not expand section", description: errorMessage(err), variant: "destructive" });
    }
  };

  const confirmExtend = async () => {
    if (!paperId) return;
    setExtending(true);
    try {
      const updated = await storageService.extendResearchPaper(paperId, extendCount);
      setDoc(updated.data);
      setExtendOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "تعذّرت الإضافة" : "Could not add sections", description: errorMessage(err), variant: "destructive" });
    } finally {
      setExtending(false);
    }
  };

  const updateSource = (index: number, value: string) =>
    setDoc((prev) => (prev ? { ...prev, sources: prev.sources.map((s, i) => (i === index ? value : s)) } : prev));
  const removeSource = (index: number) =>
    setDoc((prev) => (prev ? { ...prev, sources: prev.sources.filter((_, i) => i !== index) } : prev));
  const addSource = () => setDoc((prev) => (prev ? { ...prev, sources: [...prev.sources, ""] } : prev));

  // ── Images ──────────────────────────────────────────────────────────
  const attachImages = async (candidates: ResearchImageCandidate[]) => {
    if (!paperId) return { failures: [] };
    const result = await storageService.saveResearchImages(paperId, candidates);
    const { failures, ...updated } = result;
    setDoc(updated.data);
    if (picker?.sectionId && updated.data.images.length > 0) {
      // Newly saved images land at the end of doc.images in request order —
      // attach the ones that actually succeeded to the section that opened
      // the picker.
      const attachedIds = updated.data.images.slice(-candidates.length).map((i) => i.id).filter((id) => !failures.some((f) => f.id === id));
      if (attachedIds.length > 0) {
        setDoc((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            sections: prev.sections.map((s) => (s.id === picker.sectionId ? { ...s, imageIds: [...s.imageIds, ...attachedIds] } : s)),
          };
        });
        // Persist the section assignment on the server too (autosave will also
        // carry it, but the move endpoint keeps images.tsx state consistent
        // even if the picker closes before the debounce fires).
      }
    }
    return { failures };
  };

  const updateImageCaption = (imageId: string, caption: string) => {
    setDoc((prev) => (prev ? { ...prev, images: prev.images.map((i) => (i.id === imageId ? { ...i, caption } : i)) } : prev));
    if (paperId) storageService.updateResearchImage(paperId, imageId, { caption }).catch(() => {});
  };

  const deleteImage = async (imageId: string) => {
    if (!paperId) return;
    try {
      const updated = await storageService.deleteResearchImage(paperId, imageId);
      setDoc(updated.data);
    } catch (err) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", description: errorMessage(err), variant: "destructive" });
    }
  };

  const moveImageToSection = async (imageId: string, sectionId: string | null) => {
    if (!paperId) return;
    try {
      const updated = await storageService.updateResearchImage(paperId, imageId, { sectionId });
      setDoc(updated.data);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر النقل" : "Could not move image", description: errorMessage(err), variant: "destructive" });
    }
  };

  // ── Print / export / copy-to-Word ──────────────────────────────────
  // inlineFonts: true — reused from the print pipeline. The flag's real job
  // for print is self-containment for the tmp-file renderer, but here (a
  // clipboard write, not a file render) it matters for a different reason:
  // it's also what makes buildResearchHtml resolve doc.images to base64
  // data: URLs instead of an /api/research/... path. A relative app URL is
  // meaningless once pasted into an external app like Word, so inlining is
  // the only way embedded images have any chance of surviving the paste —
  // even though, per the spec's own warning, Word often still drops them.
  // Font embedding itself buys nothing for a paste (Word maps font-family
  // names to installed fonts regardless of an @font-face src), but the two
  // are the same flag in this module, so it comes along for free.
  const handleCopyToWord = async () => {
    if (!doc || !paperId || printSubmitting) return;
    setPrintSubmitting(true);
    try {
      const html = await buildResearchHtml({ doc, title, paperId, inlineFonts: true });
      const plain = buildResearchPlainText(doc, title);
      const nav = navigator as Navigator & { clipboard?: { write?: (items: unknown[]) => Promise<void> } };
      if (!nav.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error(isRtl ? "الحافظة غير متاحة" : "Clipboard is not available here");
      }
      await nav.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      toast({ title: isRtl ? "تم نسخ البحث — الصقه في Word" : "Copied — paste it into Word", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "تعذّر النسخ" : "Copy failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrintSubmitting(false);
    }
  };

  const handlePrint = async (opts: ResearchPrintOptions) => {
    if (!doc || !paperId || printSubmitting) return;
    setPrintSubmitting(true);
    try {
      const html = await buildResearchHtml({ doc, title, paperId, inlineFonts: true });
      if (!isElectron()) {
        toast({ title: isRtl ? "الطباعة متاحة فقط في التطبيق" : "Native printing is only available in the desktop app", variant: "destructive" });
        return;
      }
      // One render, two destinations: this PDF is either spooled here or, in
      // handleExportPdf below, written straight to the file the operator
      // picks — never re-rendered through a second path.
      const pdf = await renderHtmlPdf({ html, pageSize: "A4" });
      const result = await printData({
        data: pdf,
        fileType: "application/pdf",
        extension: ".pdf",
        printerName: opts.printerName,
        silent: true,
        options: { copies: opts.copies, color: opts.color },
      });
      if (result.ok === false && !result.cancelled) {
        throw new Error(isRtl ? "تعذّرت الطباعة" : "Could not print the research paper");
      }
      setPrintOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "تعذّرت الطباعة" : "Could not print", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrintSubmitting(false);
    }
  };

  const handleExportPdf = async (opts: ResearchPrintOptions) => {
    if (!doc || !paperId || printSubmitting) return;
    setPrintSubmitting(true);
    try {
      const html = await buildResearchHtml({ doc, title, paperId, inlineFonts: true });
      if (!isElectron()) {
        // No native PDF renderer outside Electron — open it so the browser's
        // own print-to-PDF can be used instead (same fallback as CvTool).
        window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
        setPrintOpen(false);
        return;
      }
      const pdf = await renderHtmlPdf({ html, pageSize: "A4" });
      downloadBlob(pdf, `${title || "research"}.pdf`);
      setPrintOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "فشل التصدير" : "Export failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrintSubmitting(false);
    }
  };

  // ── Saved list actions ──────────────────────────────────────────────
  const duplicatePaper = async (paper: ResearchPaper) => {
    try {
      const full = await storageService.getResearchPaper(paper.id);
      const created = await storageService.createResearchPaper({
        title: `${full.title} ${isRtl ? "(نسخة)" : "(copy)"}`,
        subject: full.subject,
        level: full.level,
        language: full.language,
        data: full.data,
      });
      loadPapers(search.trim() || undefined);
      openPaper(created);
      toast({ title: isRtl ? "تم النسخ" : "Duplicated", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "تعذّر النسخ" : "Could not duplicate", description: errorMessage(err), variant: "destructive" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await storageService.deleteResearchPaper(deleteConfirm.id);
      if (paperId === deleteConfirm.id) startNew();
      loadPapers(search.trim() || undefined);
      toast({ title: isRtl ? "تم الحذف" : "Deleted", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const openCoverPrefill = () => {
    setCoverOpen(true);
    const d = coverDefaultsRef.current;
    if (doc && !doc.schoolName && !doc.teacherName && !doc.schoolYear) {
      patchDoc({ schoolName: d.researchSchoolName, teacherName: d.researchTeacherName, schoolYear: d.researchSchoolYear });
    }
  };

  const saveCoverDefaults = () => {
    if (!doc) return;
    storageService
      .saveResearchCoverDefaults({
        researchSchoolName: doc.schoolName,
        researchTeacherName: doc.teacherName,
        researchSchoolYear: doc.schoolYear,
      })
      .then(() => {
        coverDefaultsRef.current = { researchSchoolName: doc.schoolName, researchTeacherName: doc.teacherName, researchSchoolYear: doc.schoolYear };
      })
      .catch(() => {});
  };

  const unassignedImages = doc ? doc.images.filter((img) => !doc.sections.some((s) => s.imageIds.includes(img.id))) : [];
  const simple = doc?.typography.mode === "simple";

  return (
    <div className="h-full">
      <div className="mb-6">
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground">{isRtl ? "البحوث المدرسية" : "Research Papers"}</h2>
        <p className="text-muted-foreground mt-1 text-sm sm:text-base">
          {isRtl ? "ولّد بحثًا مدرسيًا كاملاً بالذكاء الاصطناعي، عدّله، وأضف له الصور، ثم اطبعه." : "Generate a full school research paper with AI, edit it, add images, then print it."}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_360px] gap-4 items-start">
        {/* ── Saved papers list ── */}
        <div className="rounded-2xl border border-border bg-card p-3 space-y-3 lg:sticky lg:top-4">
          <Button onClick={startNew} className="w-full gap-2">
            <Icon name="plus" className="w-4 h-4" />
            {isRtl ? "بحث جديد" : "New paper"}
          </Button>
          <div className="relative">
            <Icon name="search" className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={isRtl ? "ابحث بالعنوان أو المادة..." : "Search by title or subject..."} className="ps-9" />
          </div>
          <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
            {loadingList ? (
              <div className="space-y-2 animate-pulse">
                {[1, 2, 3].map((i) => <div key={i} className="h-14 rounded-xl bg-muted" />)}
              </div>
            ) : papers.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">{isRtl ? "لا توجد بحوث محفوظة بعد" : "No saved research papers yet"}</p>
            ) : (
              papers.map((p) => (
                <div
                  key={p.id}
                  className={`rounded-xl border px-2.5 py-2 cursor-pointer transition-colors ${p.id === paperId ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20" : "border-border hover:bg-muted"}`}
                  onClick={() => openPaperById(p)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground truncate">{p.title}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 shrink-0">
                      {LEVELS.find((l) => l.id === p.level)?.[isRtl ? "ar" : "en"]}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[11px] text-muted-foreground truncate">{p.subject || (isRtl ? "بدون مادة" : "No subject")}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" title={isRtl ? "نسخ" : "Duplicate"} className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10" onClick={(e) => { e.stopPropagation(); duplicatePaper(p); }}>
                        <Icon name="copy" className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                      <button type="button" title={isRtl ? "حذف" : "Delete"} className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(p); }}>
                        <Icon name="trash" className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Editor / creation form ── */}
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4 min-w-0">
          {!doc ? (
            <CreationForm
              isRtl={isRtl}
              draft={draft}
              setDraft={setDraft}
              subjectHistory={subjectHistory}
              instructionsOpen={instructionsOpen}
              setInstructionsOpen={setInstructionsOpen}
              generating={generating}
              elapsedSec={elapsedSec}
              onGenerate={startGenerate}
              onCancel={cancelGenerate}
            />
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <Textarea
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  rows={1}
                  className={simple ? "text-xl font-extrabold min-h-0 resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" : "text-lg font-bold min-h-0 resize-none"}
                  placeholder={isRtl ? "عنوان البحث" : "Research title"}
                />
                <div className="shrink-0 flex items-center gap-2 pt-1.5">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    {saveState === "saving" && <><Spinner className="w-3.5 h-3.5" />{isRtl ? "جارٍ الحفظ..." : "Saving..."}</>}
                    {saveState === "saved" && <><Icon name="check" className="w-3.5 h-3.5 text-emerald-600" />{isRtl ? "تم الحفظ" : "Saved"}</>}
                  </span>
                  <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setPrintOpen(true)}>
                    <Icon name="print" className="w-3.5 h-3.5" />
                    {isRtl ? "طباعة" : "Print"}
                  </Button>
                </div>
              </div>

              {/* Cover page front matter — irrelevant in simple mode, which never renders a cover page */}
              {!simple && (
                <div className="rounded-xl border border-border">
                  <button type="button" onClick={() => (coverOpen ? setCoverOpen(false) : openCoverPrefill())} className="w-full flex items-center justify-between px-3 py-2.5">
                    <span className="text-sm font-semibold text-foreground">{isRtl ? "غلاف البحث" : "Cover page"}</span>
                    <Icon name={coverOpen ? "chevron-up" : "chevron-down"} className="w-4 h-4 text-muted-foreground" />
                  </button>
                  {coverOpen && (
                    <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Input value={doc.studentName} onChange={(e) => patchDoc({ studentName: e.target.value })} placeholder={isRtl ? "اسم التلميذ" : "Student name"} />
                      <Input value={doc.schoolName} onChange={(e) => patchDoc({ schoolName: e.target.value })} onBlur={saveCoverDefaults} placeholder={isRtl ? "المؤسسة" : "School"} />
                      <Input value={doc.schoolYear} onChange={(e) => patchDoc({ schoolYear: e.target.value })} onBlur={saveCoverDefaults} placeholder={isRtl ? "السنة الدراسية" : "School year"} />
                      <Input value={doc.teacherName} onChange={(e) => patchDoc({ teacherName: e.target.value })} onBlur={saveCoverDefaults} placeholder={isRtl ? "الأستاذ(ة)" : "Teacher"} />
                    </div>
                  )}
                </div>
              )}

              <EditorField label={isRtl ? "المقدمة" : "Introduction"} value={doc.introduction} onChange={(v) => patchDoc({ introduction: v })} plain={simple} />

              <div className={simple ? "space-y-1" : "space-y-3"}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{isRtl ? "الأقسام" : "Sections"}</h3>
                  <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setExtendOpen(true)}>
                    <Icon name="plus" className="w-3.5 h-3.5" />
                    {isRtl ? "إضافة أقسام" : "Add sections"}
                  </Button>
                </div>
                {doc.sections.map((section, index) => (
                  <React.Fragment key={section.id}>
                    <div
                      draggable={!simple}
                      onDragStart={() => setDragId(section.id)}
                      onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== section.id) moveSection(dragId, section.id); }}
                      onDragEnd={() => setDragId(null)}
                      className={simple ? "space-y-2" : "rounded-xl border border-border p-3 space-y-2"}
                    >
                      <div className="flex items-start gap-2">
                        {!simple && (
                          <span className="cursor-grab select-none text-muted-foreground pt-2.5 text-sm" title={isRtl ? "اسحب لإعادة الترتيب" : "Drag to reorder"}>⠿</span>
                        )}
                        <Input
                          value={section.heading}
                          onChange={(e) => patchSection(section.id, { heading: e.target.value })}
                          className={simple ? "font-extrabold text-base border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" : "font-semibold"}
                          placeholder={`${isRtl ? "عنوان القسم" : "Section heading"} ${index + 1}`}
                        />
                      </div>
                      {simple ? (
                        <AutoGrowTextarea
                          value={section.body}
                          onChange={(e) => patchSection(section.id, { body: e.target.value })}
                          className="border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 text-base leading-relaxed"
                        />
                      ) : (
                        <Textarea
                          value={section.body}
                          onChange={(e) => patchSection(section.id, { body: e.target.value })}
                          rows={4}
                          className="resize-y"
                        />
                      )}

                      <SectionImages
                        isRtl={isRtl}
                        images={doc.images.filter((img) => section.imageIds.includes(img.id))}
                        sections={doc.sections}
                        currentSectionId={section.id}
                        paperId={paperId}
                        onCaption={updateImageCaption}
                        onDelete={deleteImage}
                        onMove={moveImageToSection}
                      />

                      <div className="flex items-center justify-end gap-1 pt-1">
                        <Button type="button" size="sm" variant="ghost" className="text-xs gap-1" onClick={() => expandSection(section)}>
                          <Icon name="zap" className="w-3.5 h-3.5" />
                          {isRtl ? "توسيع" : "Expand"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="text-xs gap-1 text-red-600 dark:text-red-400" onClick={() => removeSection(section.id)}>
                          <Icon name="trash" className="w-3.5 h-3.5" />
                          {isRtl ? "حذف" : "Delete"}
                        </Button>
                      </div>
                    </div>

                    {/* Between-sections image add — always searches the paper's main topic, never the section heading */}
                    <div className="flex items-center justify-center py-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                        onClick={() => setPicker({ sectionId: section.id, initialQuery: title })}
                      >
                        <Icon name="file-image" className="w-3.5 h-3.5" />
                        {isRtl ? "إضافة صورة" : "Add image"}
                      </Button>
                    </div>
                  </React.Fragment>
                ))}
              </div>

              <EditorField label={isRtl ? "الخاتمة" : "Conclusion"} value={doc.conclusion} onChange={(v) => patchDoc({ conclusion: v })} plain={simple} />

              {/* Sources */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">{isRtl ? "المصادر" : "Sources"}</h3>
                {doc.sources.map((src, i) => (
                  <div key={i} className="flex gap-2">
                    <Input value={src} onChange={(e) => updateSource(i, e.target.value)} dir="ltr" />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeSource(i)} aria-label={isRtl ? "إزالة" : "Remove"}>
                      <Icon name="x" className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addSource}>
                  <Icon name="plus" className="w-3.5 h-3.5" />
                  {isRtl ? "إضافة مصدر" : "Add source"}
                </Button>
              </div>

              {/* Document-level images */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{isRtl ? "صور عامة للبحث" : "Document images"}</h3>
                  <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setPicker({ sectionId: null, initialQuery: title })}>
                    <Icon name="file-image" className="w-3.5 h-3.5" />
                    {isRtl ? "جلب صور" : "Fetch images"}
                  </Button>
                </div>
                {unassignedImages.length > 0 && (
                  <SectionImages
                    isRtl={isRtl}
                    images={unassignedImages}
                    sections={doc.sections}
                    currentSectionId={null}
                    paperId={paperId}
                    onCaption={updateImageCaption}
                    onDelete={deleteImage}
                    onMove={moveImageToSection}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Preview ── */}
        <div className="space-y-3 lg:sticky lg:top-4">
          {doc && (
            <TypographyToolbar
              isRtl={isRtl}
              typography={doc.typography}
              pageCount={pageCount}
              onChange={(t) => patchDoc({ typography: t })}
            />
          )}
          {!simple && (
            <div className="rounded-2xl border border-border bg-muted/30 overflow-hidden" style={{ aspectRatio: "210 / 297" }}>
              {previewHtml ? (
                <iframe title="preview" srcDoc={previewHtml} className="w-full h-full bg-white" style={{ border: 0 }} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                  {isRtl ? "ستظهر المعاينة هنا" : "The preview appears here"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {picker && (
        <ResearchImagePickerDialog
          open={!!picker}
          isRtl={isRtl}
          initialQuery={picker.initialQuery}
          onClose={() => setPicker(null)}
          onAttach={attachImages}
        />
      )}

      <Dialog open={extendOpen} onOpenChange={setExtendOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{isRtl ? "إضافة أقسام" : "Add sections"}</DialogTitle>
            <DialogDescription>{isRtl ? "كم قسمًا تريد إضافته؟ (1-6)" : "How many sections to add? (1-6)"}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-3 py-2">
            <Button type="button" variant="outline" size="icon" onClick={() => setExtendCount((n) => Math.max(1, n - 1))} disabled={extendCount <= 1}>
              <Icon name="minus" className="w-4 h-4" />
            </Button>
            <span className="text-xl font-bold w-8 text-center">{extendCount}</span>
            <Button type="button" variant="outline" size="icon" onClick={() => setExtendCount((n) => Math.min(6, n + 1))} disabled={extendCount >= 6}>
              <Icon name="plus" className="w-4 h-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendOpen(false)}>{isRtl ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={confirmExtend} disabled={extending} className="gap-1.5">
              {extending && <Spinner className="w-4 h-4" />}
              {isRtl ? "إضافة" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {doc && (
        <ResearchPrintDialog
          open={printOpen}
          isRtl={isRtl}
          defaultPrinterName={shopSettings?.defaultPrinterName || ""}
          settings={shopSettings}
          pageCount={pageCount}
          hasImages={doc.images.length > 0}
          submitting={printSubmitting}
          onClose={() => setPrintOpen(false)}
          onPrint={handlePrint}
          onExportPdf={handleExportPdf}
          onCopyToWord={handleCopyToWord}
        />
      )}

      <ConfirmDialog
        isOpen={!!deleteConfirm}
        title={isRtl ? "حذف البحث؟" : "Delete research paper?"}
        message={
          isRtl
            ? `سيتم حذف "${deleteConfirm?.title}" نهائيًا. لا يمكن التراجع.`
            : `"${deleteConfirm?.title}" will be permanently deleted. This cannot be undone.`
        }
        confirmText={isRtl ? "حذف" : "Delete"}
        cancelText={isRtl ? "إلغاء" : "Cancel"}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirm(null)}
        isDanger
        isRtl={isRtl}
      />
    </div>
  );
};

// ── Sub-components ─────────────────────────────────────────────────────

// Grows to fit its content instead of scrolling internally — used for the
// borderless "reads like the preview" fields in simple mode, where a fixed
// row count would clip a long section behind a scrollbar.
const AutoGrowTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ value, className, ...props }) => {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <Textarea ref={ref} value={value} className={`overflow-hidden resize-none ${className ?? ""}`} {...props} />;
};

const EditorField: React.FC<{ label: string; value: string; onChange: (v: string) => void; plain?: boolean }> = ({ label, value, onChange, plain }) => (
  <div className="space-y-1.5">
    <h3 className={plain ? "text-base font-extrabold text-foreground" : "text-sm font-semibold text-foreground"}>{label}</h3>
    {plain ? (
      <AutoGrowTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 text-base leading-relaxed"
      />
    ) : (
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4} className="resize-y" />
    )}
  </div>
);

const CreationForm: React.FC<{
  isRtl: boolean;
  draft: DraftForm;
  setDraft: React.Dispatch<React.SetStateAction<DraftForm>>;
  subjectHistory: string[];
  instructionsOpen: boolean;
  setInstructionsOpen: (v: boolean) => void;
  generating: boolean;
  elapsedSec: number;
  onGenerate: () => void;
  onCancel: () => void;
}> = ({ isRtl, draft, setDraft, subjectHistory, instructionsOpen, setInstructionsOpen, generating, elapsedSec, onGenerate, onCancel }) => {
  const topicRef = useRef<HTMLInputElement>(null);
  useEffect(() => { topicRef.current?.focus(); }, []);

  const subjectOptions = SUBJECTS_BY_LEVEL[draft.level];
  const [customSubject, setCustomSubject] = useState(draft.subject !== "" && !subjectOptions.includes(draft.subject));
  useEffect(() => {
    if (!customSubject && draft.subject !== "" && !subjectOptions.includes(draft.subject)) {
      setDraft((p) => ({ ...p, subject: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.level]);

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "الموضوع" : "Topic"}</label>
        <Input
          ref={topicRef}
          value={draft.topic}
          onChange={(e) => setDraft((p) => ({ ...p, topic: e.target.value }))}
          placeholder={isRtl ? "مثال: التلوث البيئي" : "e.g. Environmental pollution"}
          disabled={generating}
          onKeyDown={(e) => { if (e.key === "Enter" && !generating) onGenerate(); }}
        />
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "المستوى" : "Level"}</label>
        <div className="inline-flex rounded-xl border border-border p-0.5 bg-muted/40">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={generating}
              onClick={() => setDraft((p) => ({ ...p, level: l.id }))}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${draft.level === l.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
            >
              {isRtl ? l.ar : l.en}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "المادة" : "Subject"}</label>
        {customSubject ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              list="research-subject-history"
              value={draft.subject}
              onChange={(e) => setDraft((p) => ({ ...p, subject: e.target.value }))}
              placeholder={isRtl ? "اكتب اسم المادة" : "Type the subject"}
              disabled={generating}
            />
            <Button type="button" variant="outline" size="sm" disabled={generating} onClick={() => { setCustomSubject(false); setDraft((p) => ({ ...p, subject: "" })); }}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <datalist id="research-subject-history">
              {subjectHistory.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
        ) : (
          <Select
            value={draft.subject || undefined}
            onValueChange={(v) => {
              if (v === OTHER_SUBJECT) { setCustomSubject(true); setDraft((p) => ({ ...p, subject: "" })); return; }
              setDraft((p) => ({ ...p, subject: v }));
            }}
            disabled={generating}
          >
            <SelectTrigger>
              <SelectValue placeholder={isRtl ? "اختر المادة" : "Choose subject"} />
            </SelectTrigger>
            <SelectContent>
              {subjectOptions.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
              <SelectItem value={OTHER_SUBJECT}>{isRtl ? "أخرى..." : "Other..."}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "اللغة" : "Language"}</label>
        <div className="inline-flex rounded-xl border border-border p-0.5 bg-muted/40">
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={generating}
              onClick={() => setDraft((p) => ({ ...p, language: l.id }))}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${draft.language === l.id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
            >
              {isRtl ? l.ar : l.en}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">
          {isRtl ? `الطول: ${researchLengthLabel(draft.targetPages, isRtl)}` : `Length: ${researchLengthLabel(draft.targetPages, isRtl)}`}
        </label>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" disabled={generating || draft.targetPages <= 0.5} onClick={() => setDraft((p) => ({ ...p, targetPages: Math.max(0.5, Math.round((p.targetPages - 0.5) * 2) / 2) }))}>
            <Icon name="minus" className="w-4 h-4" />
          </Button>
          <input
            type="range"
            min={0.5}
            max={15}
            step={0.5}
            value={draft.targetPages}
            disabled={generating}
            onChange={(e) => setDraft((p) => ({ ...p, targetPages: Number(e.target.value) }))}
            className="flex-1"
          />
          <Button type="button" variant="outline" size="icon" disabled={generating || draft.targetPages >= 15} onClick={() => setDraft((p) => ({ ...p, targetPages: Math.min(15, Math.round((p.targetPages + 0.5) * 2) / 2) }))}>
            <Icon name="plus" className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {isRtl ? "اختر فقرة قصيرة لبحوث الابتدائي البسيطة، أو عدة صفحات لبحث كامل." : "Pick a short paragraph for simple primary-school asks, or several pages for a full paper."}
        </p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "المصادر" : "Sources"}</label>
        <div className="inline-flex rounded-xl border border-border p-0.5 bg-muted/40">
          <button
            type="button"
            disabled={generating}
            onClick={() => setDraft((p) => ({ ...p, includeSources: true }))}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${draft.includeSources ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
          >
            {isRtl ? "مع المصادر" : "With sources"}
          </button>
          <button
            type="button"
            disabled={generating}
            onClick={() => setDraft((p) => ({ ...p, includeSources: false }))}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${!draft.includeSources ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
          >
            {isRtl ? "بدون مصادر" : "No sources"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border">
        <button type="button" onClick={() => setInstructionsOpen(!instructionsOpen)} className="w-full flex items-center justify-between px-3 py-2.5">
          <span className="text-sm font-semibold text-foreground">{isRtl ? "تعليمات إضافية" : "Custom instructions"}</span>
          <Icon name={instructionsOpen ? "chevron-up" : "chevron-down"} className="w-4 h-4 text-muted-foreground" />
        </button>
        {instructionsOpen && (
          <div className="px-3 pb-3">
            <Textarea
              value={draft.customInstructions}
              onChange={(e) => setDraft((p) => ({ ...p, customInstructions: e.target.value }))}
              rows={3}
              disabled={generating}
              placeholder={isRtl ? "أي تعليمات إضافية للنموذج..." : "Any extra instructions for the model..."}
            />
          </div>
        )}
      </div>

      {!generating ? (
        <Button onClick={onGenerate} size="lg" className="w-full gap-2">
          <Icon name="zap" className="w-4 h-4" />
          {isRtl ? "توليد البحث" : "Generate the paper"}
        </Button>
      ) : (
        <div className="rounded-xl border border-border p-4 space-y-3">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full w-1/3 bg-primary rounded-full animate-[research-progress_1.4s_ease-in-out_infinite]" />
          </div>
          <style>{`@keyframes research-progress{0%{margin-inline-start:-33%}50%{margin-inline-start:66%}100%{margin-inline-start:-33%}}`}</style>
          <p className="text-sm text-center text-muted-foreground">
            {isRtl ? `جارٍ التوليد... (${elapsedSec} ثانية) — عادة 20-60 ثانية` : `Generating... (${elapsedSec}s) — usually 20-60s`}
          </p>
          <Button variant="outline" className="w-full gap-2" onClick={onCancel}>
            <Icon name="x" className="w-4 h-4" />
            {isRtl ? "إلغاء" : "Cancel"}
          </Button>
        </div>
      )}
    </div>
  );
};

const TypographyToolbar: React.FC<{
  isRtl: boolean;
  typography: ResearchTypography;
  pageCount: number | null;
  onChange: (t: ResearchTypography) => void;
}> = ({ isRtl, typography, pageCount, onChange }) => {
  const simple = typography.mode === "simple";
  return (
  <div className="rounded-2xl border border-border bg-card p-3 space-y-3">
    <div className="flex items-center justify-between gap-2 pb-1 border-b border-border">
      <span className="text-xs font-medium text-muted-foreground">{isRtl ? "الوضع" : "Mode"}</span>
      <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
        <button
          type="button"
          onClick={() => onChange({ ...typography, mode: "simple" })}
          className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${simple ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
        >
          {isRtl ? "بسيط" : "Simple"}
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...typography, mode: "advanced" })}
          className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${!simple ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
        >
          {isRtl ? "متقدم" : "Advanced"}
        </button>
      </div>
    </div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{isRtl ? "حجم الخط" : "Font size"}</span>
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={typography.fontSize <= 10} onClick={() => onChange({ ...typography, fontSize: typography.fontSize - 1 })}>
          <Icon name="minus" className="w-3.5 h-3.5" />
        </Button>
        <span className="text-xs w-6 text-center">{typography.fontSize}</span>
        <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={typography.fontSize >= 18} onClick={() => onChange({ ...typography, fontSize: typography.fontSize + 1 })}>
          <Icon name="plus" className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{isRtl ? "تباعد الأسطر" : "Line spacing"}</span>
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={typography.lineHeight <= 1} onClick={() => onChange({ ...typography, lineHeight: Math.round((typography.lineHeight - 0.1) * 10) / 10 })}>
          <Icon name="minus" className="w-3.5 h-3.5" />
        </Button>
        <span className="text-xs w-8 text-center">{typography.lineHeight.toFixed(1)}</span>
        <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={typography.lineHeight >= 2.5} onClick={() => onChange({ ...typography, lineHeight: Math.round((typography.lineHeight + 0.1) * 10) / 10 })}>
          <Icon name="plus" className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{isRtl ? "نوع الخط" : "Font"}</span>
      <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
        {FONT_FAMILIES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange({ ...typography, fontFamily: f.id })}
            className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${typography.fontFamily === f.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
          >
            {isRtl ? f.ar : f.en}
          </button>
        ))}
      </div>
    </div>
    {!simple && (
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{isRtl ? "الهوامش" : "Margins"}</span>
        <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
          {MARGIN_PRESETS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange({ ...typography, margin: m.id })}
              className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${(typography.margin ?? "default") === m.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
            >
              {isRtl ? m.ar : m.en}
            </button>
          ))}
        </div>
      </div>
    )}
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{isRtl ? "حجم الصور" : "Image size"}</span>
      <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
        {IMAGE_SIZE_PRESETS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange({ ...typography, imageSize: s.id })}
            className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${(typography.imageSize ?? "default") === s.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"}`}
          >
            {isRtl ? s.ar : s.en}
          </button>
        ))}
      </div>
    </div>
    {!simple && (
      <>
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border">
          <span className="text-xs font-medium text-muted-foreground">{isRtl ? "صفحة الغلاف" : "Cover page"}</span>
          <Button
            type="button"
            size="sm"
            variant={typography.showCoverPage === false ? "outline" : "default"}
            className="h-6 px-2 text-[11px]"
            onClick={() => onChange({ ...typography, showCoverPage: typography.showCoverPage === false })}
          >
            {typography.showCoverPage === false ? (isRtl ? "مخفية" : "Off") : isRtl ? "ظاهرة" : "On"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{isRtl ? "فهرس المحتويات" : "Table of contents"}</span>
          <Button
            type="button"
            size="sm"
            variant={typography.showToc === false ? "outline" : "default"}
            className="h-6 px-2 text-[11px]"
            onClick={() => onChange({ ...typography, showToc: typography.showToc === false })}
          >
            {typography.showToc === false ? (isRtl ? "مخفي" : "Off") : isRtl ? "ظاهر" : "On"}
          </Button>
        </div>
      </>
    )}
    <div className="text-center text-xs font-semibold text-foreground pt-1 border-t border-border">
      {pageCount == null ? (isRtl ? "جارٍ الحساب..." : "Calculating...") : isRtl ? `≈ ${pageCount} صفحات` : `≈ ${pageCount} pages`}
    </div>
  </div>
  );
};

const SectionImages: React.FC<{
  isRtl: boolean;
  images: { id: string; caption: string }[];
  sections: ResearchSection[];
  currentSectionId: string | null;
  paperId: string | null;
  onCaption: (imageId: string, caption: string) => void;
  onDelete: (imageId: string) => void;
  onMove: (imageId: string, sectionId: string | null) => void;
}> = ({ isRtl, images, sections, currentSectionId, paperId, onCaption, onDelete, onMove }) => {
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
      {images.map((img) => (
        <ImageChip key={img.id} isRtl={isRtl} image={img} sections={sections} currentSectionId={currentSectionId} paperId={paperId} onCaption={onCaption} onDelete={onDelete} onMove={onMove} />
      ))}
    </div>
  );
};

const thumbCache = new Map<string, string>();

const ImageChip: React.FC<{
  isRtl: boolean;
  image: { id: string; caption: string };
  sections: ResearchSection[];
  currentSectionId: string | null;
  paperId: string | null;
  onCaption: (imageId: string, caption: string) => void;
  onDelete: (imageId: string) => void;
  onMove: (imageId: string, sectionId: string | null) => void;
}> = ({ isRtl, image, sections, currentSectionId, paperId, onCaption, onDelete, onMove }) => {
  const [src, setSrc] = useState<string | null>(() => (paperId ? thumbCache.get(`${paperId}:${image.id}`) || null : null));
  const [caption, setCaption] = useState(image.caption);

  useEffect(() => {
    if (!paperId) return;
    const key = `${paperId}:${image.id}`;
    const cached = thumbCache.get(key);
    if (cached) { setSrc(cached); return; }
    let cancelled = false;
    storageService.fetchResearchImageDataUrl(paperId, image.id).then((url) => {
      if (cancelled || !url) return;
      thumbCache.set(key, url);
      setSrc(url);
    });
    return () => { cancelled = true; };
  }, [paperId, image.id]);

  useEffect(() => setCaption(image.caption), [image.caption]);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="aspect-video bg-muted flex items-center justify-center">
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <Spinner className="w-4 h-4 text-muted-foreground" />}
      </div>
      <div className="p-1.5 space-y-1">
        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() => onCaption(image.id, caption)}
          placeholder={isRtl ? "تعليق الصورة" : "Caption"}
          className="h-7 text-xs px-2"
        />
        <div className="flex items-center gap-1">
          <select
            value={currentSectionId ?? ""}
            onChange={(e) => onMove(image.id, e.target.value || null)}
            className="flex-1 h-7 text-[11px] rounded-md border border-input bg-background px-1"
          >
            <option value="">{isRtl ? "بدون قسم" : "Unassigned"}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.heading || (isRtl ? "(بدون عنوان)" : "(untitled)")}</option>
            ))}
          </select>
          <button type="button" title={isRtl ? "حذف" : "Delete"} className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 shrink-0" onClick={() => onDelete(image.id)}>
            <Icon name="trash" className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ResearchTool;
