import React, { useEffect, useMemo, useRef, useState } from "react";
import { Language, CvProfile, CvDocument, CvEntry, CvCustomSection, CvLanguage, CvTemplateId, ShopSettings } from "../types";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card, CardContent } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Switch } from "../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { errorMessage } from "@atba3li/shared";
import { isElectron, printData, renderHtmlPdf } from "../lib/electronPrint";
import CvPrintDialog, { CvPrintOptions } from "../components/CvPrintDialog";
import { buildCvHtml, normalizeCvDocument } from "../components/cvDocument";
import { inlineCardAssets } from "../components/credentialCard";

interface CvToolProps {
  lang: Language;
}

const uid = () => crypto.randomUUID();

const emptyEntry = (): CvEntry => ({ id: uid(), title: "", subtitle: "", period: "", description: "" });
const emptySection = (): CvCustomSection => ({ id: uid(), title: "", content: "" });

const emptyData = (docLang: CvLanguage): CvDocument => normalizeCvDocument({ language: docLang }, docLang);

// Not window.open(): under Electron an about:blank popup is handed to the OS
// shell instead of printing — same reasoning as CredentialsTool/QrPosterDialog.
const printViaIframe = (html: string) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;height:600px;border:0;";
  frame.srcdoc = html;
  frame.onload = async () => {
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      return;
    }
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    win.addEventListener("afterprint", cleanup, { once: true });
    await Promise.race([
      win.document.fonts?.ready ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 3000)),
    ]).catch(() => undefined);
    try {
      win.focus();
      win.print();
    } catch {
      frame.remove();
      return;
    }
    setTimeout(cleanup, 60000);
  };
  document.body.appendChild(frame);
};

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

/** Windows rejects \ / : * ? " < > | in filenames. */
const safeFilename = (name: string) => (name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "cv").slice(0, 80);

const TEMPLATE_LABELS: Record<CvTemplateId, { en: string; ar: string }> = {
  modern: { en: "Modern", ar: "عصري" },
  classic: { en: "Classic", ar: "كلاسيكي" },
  minimal: { en: "Minimal", ar: "بسيط" },
  azure: { en: "Azure", ar: "أزرق إداري" },
};

const DOC_LANG_LABELS: Record<CvLanguage, { en: string; ar: string }> = {
  ar: { en: "Arabic", ar: "العربية" },
  en: { en: "English", ar: "الإنجليزية" },
  fr: { en: "French", ar: "الفرنسية" },
};

// One-click entries for the lists customers dictate most often, written in
// the CV's own language (not the app's).
const LANGUAGE_SUGGESTIONS: Record<CvLanguage, string[]> = {
  ar: ["العربية — اللغة الأم", "الفرنسية — جيد", "الإنجليزية — متوسط", "الأمازيغية — جيد"],
  en: ["Arabic — Native", "French — Good", "English — Intermediate", "Tamazight — Good"],
  fr: ["Arabe — Langue maternelle", "Français — Bon niveau", "Anglais — Intermédiaire", "Tamazight — Bon niveau"],
};

const SKILL_SUGGESTIONS: Record<CvLanguage, string[]> = {
  ar: ["العمل ضمن فريق", "التواصل", "الالتزام بالمواعيد", "إتقان الحاسوب", "Microsoft Office", "رخصة السياقة"],
  en: ["Teamwork", "Communication", "Punctuality", "Computer literacy", "Microsoft Office", "Driving licence"],
  fr: ["Travail en équipe", "Communication", "Ponctualité", "Maîtrise de l'outil informatique", "Microsoft Office", "Permis de conduire"],
};

// A4 width in CSS px (210mm at 96dpi) — the preview iframe renders at this
// width and is scaled down to fit its column.
const A4_PX_WIDTH = 794;
const A4_PX_HEIGHT = 1123;

// Simple add-on-Enter / remove-with-x tag editor, shared by Skills and
// Languages spoken — both are just freeform string lists.
const TagField: React.FC<{
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  suggestions?: string[];
  suggestionsLabel?: string;
  removeLabel: string;
}> = ({ values, onChange, placeholder, suggestions = [], suggestionsLabel, removeLabel }) => {
  const [draft, setDraft] = useState("");
  const add = (value = draft) => {
    const v = value.trim();
    if (!v) return;
    // Pasting "a, b, c" adds three tags.
    const parts = v.split(/[,،;\n]+/).map((p) => p.trim()).filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft("");
  };
  const unused = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
  return (
    <div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map((v, i) => (
            <span key={`${v}-${i}`} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-foreground">
              {v}
              <button type="button" onClick={() => onChange(values.filter((_, idx) => idx !== i))} aria-label={removeLabel}>
                <Icon name="x" className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={() => add()} aria-label={placeholder}>
          <Icon name="plus" className="w-4 h-4" />
        </Button>
      </div>
      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {suggestionsLabel && <span className="text-[11px] text-muted-foreground">{suggestionsLabel}</span>}
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="text-[11px] px-2 py-0.5 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-indigo-400 transition"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Up / down / remove controls for a row in an ordered list. */
const RowControls: React.FC<{
  index: number;
  count: number;
  isRtl: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}> = ({ index, count, isRtl, onMove, onRemove }) => (
  <div className="flex justify-end gap-1">
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => onMove(-1)} aria-label={isRtl ? "تحريك لأعلى" : "Move up"} title={isRtl ? "تحريك لأعلى" : "Move up"}>
      <Icon name="chevron-up" className="w-4 h-4" />
    </Button>
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={isRtl ? "تحريك لأسفل" : "Move down"} title={isRtl ? "تحريك لأسفل" : "Move down"}>
      <Icon name="chevron-down" className="w-4 h-4" />
    </Button>
    <Button type="button" variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={onRemove}>
      <Icon name="trash" className="w-3.5 h-3.5" />
      {isRtl ? "إزالة" : "Remove"}
    </Button>
  </div>
);

const moveItem = <T,>(list: T[], index: number, dir: -1 | 1): T[] => {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

/** Live, scaled-down A4 rendering of the CV as it is being typed. */
const CvLivePreview: React.FC<{ html: string; isRtl: boolean }> = ({ html, isRtl }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.45);
  const [debouncedHtml, setDebouncedHtml] = useState(html);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedHtml(html), 300);
    return () => clearTimeout(t);
  }, [html]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / A4_PX_WIDTH));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="lg:sticky lg:top-0">
      <p className="text-xs font-semibold text-muted-foreground mb-2">{isRtl ? "معاينة مباشرة" : "Live preview"}</p>
      {/* Pinned to the left edge in both directions: in an RTL page the wide
          iframe would otherwise hang off the right edge before scaling. */}
      <div ref={boxRef} dir="ltr" className="relative w-full rounded-lg border border-border bg-white overflow-hidden" style={{ height: A4_PX_HEIGHT * scale }}>
        <iframe
          title={isRtl ? "معاينة السيرة الذاتية" : "CV preview"}
          srcDoc={debouncedHtml}
          sandbox="allow-same-origin"
          className="absolute left-0 top-0 pointer-events-none"
          style={{ width: A4_PX_WIDTH, height: A4_PX_HEIGHT, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5">
        {isRtl ? "الصفحة الأولى من A4. المحتوى الطويل ينتقل إلى صفحة ثانية عند الطباعة." : "First A4 page. Longer content flows onto a second page when printed."}
      </p>
    </div>
  );
};

const CvTool: React.FC<CvToolProps> = ({ lang }) => {
  const isRtl = lang === "ar";
  const tr = (ar: string, en: string) => (isRtl ? ar : en);

  const [profiles, setProfiles] = useState<CvProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [shopSettings, setShopSettings] = useState<ShopSettings | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [data, setData] = useState<CvDocument>(() => emptyData(isRtl ? "ar" : "en"));
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [hadSavedPhoto, setHadSavedPhoto] = useState(false);
  const [removeSavedPhoto, setRemoveSavedPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<CvProfile | null>(null);

  const [printCv, setPrintCv] = useState<CvProfile | null>(null);
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const loadProfiles = async (q?: string) => {
    try {
      setProfiles(await storageService.getCvProfiles(q));
    } catch (err) {
      console.error("Failed to load CVs:", err);
      toast({ title: tr("فشل تحميل البيانات", "Failed to load CVs"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    storageService.getSettings().then(setShopSettings).catch(() => {});
  }, []);

  // Also performs the initial load (search starts empty).
  useEffect(() => {
    const handle = setTimeout(() => loadProfiles(search.trim() || undefined), search ? 250 : 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Every edit goes through these, so "unsaved changes" is tracked in one place.
  const editData = (updater: (prev: CvDocument) => CvDocument) => {
    setData(updater);
    setDirty(true);
  };
  const editName = (v: string) => { setFullName(v); setDirty(true); };
  const editPhone = (v: string) => { setPhone(v); setDirty(true); };

  const resetPhotoState = () => {
    setPhotoFile(null);
    setRemoveSavedPhoto(false);
    setHadSavedPhoto(false);
    setPhotoPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const openAddDialog = () => {
    setEditingId(null);
    setFullName("");
    setPhone("");
    setData(emptyData(isRtl ? "ar" : "en"));
    resetPhotoState();
    setDirty(false);
    setDialogOpen(true);
  };

  const openEditDialog = async (cv: CvProfile) => {
    try {
      const full = await storageService.getCvProfile(cv.id);
      setEditingId(full.id);
      setFullName(full.fullName);
      setPhone(full.phone);
      setData(normalizeCvDocument(full.data, isRtl ? "ar" : "en"));
      resetPhotoState();
      if (full.photoFilename) {
        setHadSavedPhoto(true);
        storageService.fetchCvPhotoDataUrl(full.id).then((url) => { if (url) setPhotoPreview(url); }).catch(() => {});
      }
      setDirty(false);
      setDialogOpen(true);
    } catch (err) {
      toast({ title: tr("تعذّر فتح السيرة", "Could not open the CV"), description: errorMessage(err), variant: "destructive" });
    }
  };

  const requestClose = () => {
    if (dirty && !saving) setDiscardConfirm(true);
    else setDialogOpen(false);
  };

  const onPickPhoto = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: tr("اختر ملف صورة", "Choose an image file"), variant: "destructive" });
      return;
    }
    setPhotoPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setPhotoFile(file);
    setRemoveSavedPhoto(false);
    setDirty(true);
    // The photo was picked, so the operator clearly wants it shown.
    setData((prev) => (prev.fields.photo ? prev : { ...prev, fields: { ...prev.fields, photo: true } }));
  };

  const clearPhoto = () => {
    setPhotoPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
    setPhotoFile(null);
    if (hadSavedPhoto) setRemoveSavedPhoto(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setDirty(true);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!fullName.trim()) {
      toast({ title: tr("الاسم مطلوب", "Name is required"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = { fullName: fullName.trim(), phone: phone.trim(), data };
      const saved = editingId
        ? await storageService.updateCvProfile(editingId, payload)
        : await storageService.createCvProfile(payload);
      // From here on this is an existing record — if the photo step below
      // fails and the operator presses Save again, it must update, not create
      // a second copy.
      setEditingId(saved.id);
      if (photoFile) {
        await storageService.uploadCvPhoto(saved.id, photoFile);
        setPhotoFile(null);
        setHadSavedPhoto(true);
      } else if (removeSavedPhoto) {
        await storageService.removeCvPhoto(saved.id);
        setRemoveSavedPhoto(false);
        setHadSavedPhoto(false);
      }
      toast({ title: editingId ? tr("تم التحديث", "Updated") : tr("تمت الإضافة", "Added"), variant: "success" });
      setDirty(false);
      setDialogOpen(false);
      loadProfiles(search.trim() || undefined);
    } catch (err) {
      toast({ title: tr("فشل الحفظ", "Failed to save"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async (cv: CvProfile) => {
    try {
      const copy = await storageService.duplicateCvProfile(cv.id, `${cv.fullName} (${tr("نسخة", "copy")})`);
      toast({ title: tr("تم إنشاء نسخة", "Copy created"), variant: "success" });
      await loadProfiles(search.trim() || undefined);
      openEditDialog(copy);
    } catch (err) {
      toast({ title: tr("تعذّر النسخ", "Could not duplicate"), description: errorMessage(err), variant: "destructive" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await storageService.deleteCvProfile(deleteConfirm.id);
      toast({ title: tr("تم الحذف", "Deleted"), variant: "success" });
      loadProfiles(search.trim() || undefined);
    } catch (err) {
      toast({ title: tr("فشل الحذف", "Delete failed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const openPrintDialog = async (cv: CvProfile) => {
    try {
      const full = await storageService.getCvProfile(cv.id);
      setPrintCv(full);
      setPrintOptionsOpen(true);
    } catch (err) {
      toast({ title: tr("تعذّر فتح السيرة", "Could not open the CV"), description: errorMessage(err), variant: "destructive" });
    }
  };

  const buildHtml = async (cv: CvProfile) => {
    const doc = normalizeCvDocument(cv.data);
    const photoDataUrl = doc.fields.photo && cv.photoFilename ? await storageService.fetchCvPhotoDataUrl(cv.id) : null;
    return inlineCardAssets(buildCvHtml({ profile: cv, photoDataUrl }));
  };

  const handlePrint = async (opts: CvPrintOptions) => {
    if (!printCv || printing) return;
    setPrinting(true);
    try {
      const html = await buildHtml(printCv);
      if (!isElectron()) {
        printViaIframe(html);
        setPrintOptionsOpen(false);
        return;
      }
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
        throw new Error(tr("تعذّرت الطباعة", "Could not print the CV"));
      }
      setPrintOptionsOpen(false);
    } catch (err) {
      toast({ title: tr("تعذّرت الطباعة", "Could not print"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  const handleExportPdf = async () => {
    if (!printCv || printing) return;
    setPrinting(true);
    try {
      const html = await buildHtml(printCv);
      if (!isElectron()) {
        // No native PDF renderer outside Electron — open it so the browser's
        // own print-to-PDF can be used instead.
        window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
        setPrintOptionsOpen(false);
        return;
      }
      const pdf = await renderHtmlPdf({ html, pageSize: "A4" });
      downloadBlob(pdf, `${safeFilename(printCv.fullName)}.pdf`);
      setPrintOptionsOpen(false);
    } catch (err) {
      toast({ title: tr("فشل التصدير", "Export failed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  const setField = <K extends keyof CvDocument["fields"]>(key: K, value: boolean) =>
    editData((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));

  const updateEntry = (list: "experience" | "education", id: string, patch: Partial<CvEntry>) =>
    editData((prev) => ({ ...prev, [list]: prev[list].map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  const addEntry = (list: "experience" | "education") =>
    editData((prev) => ({ ...prev, [list]: [...prev[list], emptyEntry()] }));

  const removeEntry = (list: "experience" | "education", id: string) =>
    editData((prev) => ({ ...prev, [list]: prev[list].filter((e) => e.id !== id) }));

  const moveEntry = (list: "experience" | "education", index: number, dir: -1 | 1) =>
    editData((prev) => ({ ...prev, [list]: moveItem(prev[list], index, dir) }));

  const updateSection = (id: string, patch: Partial<CvCustomSection>) =>
    editData((prev) => ({ ...prev, customSections: prev.customSections.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSection = () => editData((prev) => ({ ...prev, customSections: [...prev.customSections, emptySection()] }));
  const removeSection = (id: string) => editData((prev) => ({ ...prev, customSections: prev.customSections.filter((s) => s.id !== id) }));
  const moveSection = (index: number, dir: -1 | 1) =>
    editData((prev) => ({ ...prev, customSections: moveItem(prev.customSections, index, dir) }));

  const previewHtml = useMemo(
    () =>
      buildCvHtml({
        profile: { id: editingId || "draft", fullName: fullName || tr("الاسم الكامل", "Full name"), phone, photoFilename: "", data },
        photoDataUrl: data.fields.photo ? photoPreview : null,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullName, phone, data, photoPreview, editingId, isRtl],
  );

  const renderEntries = (list: "experience" | "education") => {
    const entries = data[list];
    const isExp = list === "experience";
    return (
      <div className="rounded-lg border border-border px-3 py-2.5 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-foreground">
            {isExp ? tr("الخبرة المهنية", "Experience") : tr("التعليم", "Education")}
            {entries.length > 0 && <span className="ms-1.5 text-xs font-normal text-muted-foreground">({entries.length})</span>}
          </label>
          <Switch checked={data.fields[list]} onCheckedChange={(c) => setField(list, c)} aria-label={tr("إظهار في السيرة", "Show on CV")} />
        </div>
        {entries.map((entry, index) => (
          <div key={entry.id} className="rounded-lg border border-border px-3 py-2.5 space-y-2 bg-muted/30">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input
                value={entry.title}
                onChange={(e) => updateEntry(list, entry.id, { title: e.target.value })}
                placeholder={isExp ? tr("المسمى الوظيفي", "Job title") : tr("الشهادة", "Degree")}
              />
              <Input
                value={entry.subtitle}
                onChange={(e) => updateEntry(list, entry.id, { subtitle: e.target.value })}
                placeholder={isExp ? tr("الشركة / المكان", "Company") : tr("المؤسسة", "School")}
              />
              <Input
                value={entry.period}
                onChange={(e) => updateEntry(list, entry.id, { period: e.target.value })}
                placeholder={tr("الفترة (مثال: 2020 – 2023)", "Period (e.g. 2020 – 2023)")}
              />
            </div>
            <Textarea
              value={entry.description}
              onChange={(e) => updateEntry(list, entry.id, { description: e.target.value })}
              placeholder={tr("وصف مختصر (اختياري) — سطر لكل نقطة", "Short description (optional) — one line per point")}
              rows={2}
            />
            <RowControls
              index={index}
              count={entries.length}
              isRtl={isRtl}
              onMove={(dir) => moveEntry(list, index, dir)}
              onRemove={() => removeEntry(list, entry.id)}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => addEntry(list)}>
          <Icon name="plus" className="w-3.5 h-3.5" />
          {isExp ? tr("إضافة خبرة", "Add experience") : tr("إضافة تعليم", "Add education")}
        </Button>
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">{tr("السير الذاتية", "CVs")}</h2>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            {tr("أنشئ سيرة ذاتية للعميل واحفظها لإعادة الطباعة لاحقًا", "Build a customer's CV and save it to reprint later")}
          </p>
        </div>
        <Button onClick={openAddDialog} className="gap-2 shrink-0">
          <Icon name="plus" className="w-4 h-4" />
          {tr("سيرة جديدة", "New CV")}
        </Button>
      </div>

      {!loading && (profiles.length > 0 || search) && (
        <div className="relative mb-4">
          <Icon name="search" className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tr("بحث بالاسم أو الهاتف...", "Search by name or phone...")}
            className="ps-9"
          />
        </div>
      )}

      {loading ? (
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-muted" />
          ))}
        </div>
      ) : profiles.length === 0 ? (
        <div className="p-12 text-center bg-card rounded-2xl border border-border">
          <Icon name={search ? "search" : "user"} className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-muted-foreground">{search ? tr("لا نتائج مطابقة", "No matches") : tr("لا توجد سير ذاتية بعد", "No CVs yet")}</p>
          {!search && (
            <Button variant="outline" onClick={openAddDialog} className="mt-4 gap-2">
              <Icon name="plus" className="w-4 h-4" />
              {tr("إنشاء أول سيرة ذاتية", "Create your first CV")}
            </Button>
          )}
        </div>
      ) : (
        <Card className="border-0">
          <CardContent className="p-0">
            <div className="divide-y divide-gray-100 dark:divide-white/10">
              {profiles.map((cv) => {
                const doc = normalizeCvDocument(cv.data);
                return (
                  <div key={cv.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 text-start" onClick={() => openEditDialog(cv)}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground hover:underline">{cv.fullName}</span>
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                          {DOC_LANG_LABELS[doc.language][isRtl ? "ar" : "en"]}
                        </span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {TEMPLATE_LABELS[doc.templateId][isRtl ? "ar" : "en"]}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <span dir="ltr">{cv.phone || tr("بدون رقم هاتف", "No phone")}</span>
                        {doc.jobTitle && <> · {doc.jobTitle}</>}
                      </p>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="outline" size="sm" className="text-xs h-8 px-2.5 gap-1" onClick={() => openPrintDialog(cv)}>
                        <Icon name="print" className="w-3 h-3" />
                        {tr("طباعة", "Print")}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" title={tr("تعديل", "Edit")} onClick={() => openEditDialog(cv)} aria-label={tr("تعديل", "Edit")}>
                        <Icon name="edit" className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" title={tr("نسخ كسيرة جديدة", "Duplicate")} onClick={() => handleDuplicate(cv)} aria-label={tr("نسخ", "Duplicate")}>
                        <Icon name="copy" className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" title={tr("حذف", "Delete")} onClick={() => setDeleteConfirm(cv)} aria-label={tr("حذف", "Delete")}>
                        <Icon name="trash" className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add / Edit Dialog — form + live preview */}
      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : requestClose())}>
        <DialogContent
          className="max-h-[94vh] overflow-y-auto max-w-[min(1240px,96vw)]"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              handleSave();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{editingId ? tr("تعديل السيرة الذاتية", "Edit CV") : tr("سيرة ذاتية جديدة", "New CV")}</DialogTitle>
            <DialogDescription>
              {tr(
                "املأ ما يلزم فقط — الأقسام الفارغة لا تظهر. فعّل/عطّل الأقسام، ورتّب العناصر بالأسهم. Ctrl+S للحفظ.",
                "Fill only what's needed — empty sections are left out. Toggle sections, reorder rows with the arrows. Ctrl+S saves.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-6 items-start">
            <div className="space-y-5 min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">{tr("لغة المستند", "Document language")}</label>
                  <Select value={data.language} onValueChange={(v) => editData((prev) => ({ ...prev, language: v as CvLanguage }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["ar", "en", "fr"] as CvLanguage[]).map((l) => (
                        <SelectItem key={l} value={l}>{DOC_LANG_LABELS[l][isRtl ? "ar" : "en"]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">{tr("التصميم", "Template")}</label>
                  <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={tr("التصميم", "Template")}>
                    {(["modern", "classic", "minimal", "azure"] as CvTemplateId[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={data.templateId === t}
                        onClick={() => editData((prev) => ({ ...prev, templateId: t }))}
                        className={`rounded-md border px-1 py-2 text-xs font-medium transition ${
                          data.templateId === t
                            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {TEMPLATE_LABELS[t][isRtl ? "ar" : "en"]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">
                    {tr("الاسم الكامل", "Full name")} <span className="text-red-500">*</span>
                  </label>
                  <Input value={fullName} onChange={(e) => editName(e.target.value)} autoFocus />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">{tr("المسمى الوظيفي", "Job title")}</label>
                  <Input value={data.jobTitle} onChange={(e) => editData((prev) => ({ ...prev, jobTitle: e.target.value }))} />
                </div>
              </div>

              {/* Photo */}
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-14 h-14 rounded-full bg-muted overflow-hidden flex items-center justify-center shrink-0 ring-offset-2 hover:ring-2 hover:ring-indigo-400 transition"
                    aria-label={tr("اختر صورة", "Choose photo")}
                  >
                    {photoPreview ? <img src={photoPreview} alt="" className="w-full h-full object-cover" /> : <Icon name="camera" className="w-5 h-5 text-muted-foreground" />}
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{tr("الصورة الشخصية", "Photo")}</p>
                    <div className="flex items-center gap-3">
                      <button type="button" className="text-xs text-indigo-600 dark:text-indigo-400 underline" onClick={() => fileInputRef.current?.click()}>
                        {photoPreview ? tr("تغيير الصورة", "Change photo") : tr("اختر صورة", "Choose photo")}
                      </button>
                      {photoPreview && (
                        <button type="button" className="text-xs text-red-600 dark:text-red-400 underline" onClick={clearPhoto}>
                          {tr("إزالة", "Remove")}
                        </button>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => onPickPhoto(e.target.files?.[0] || null)}
                    />
                  </div>
                </div>
                <Switch checked={data.fields.photo} onCheckedChange={(c) => setField("photo", c)} aria-label={tr("إظهار الصورة", "Show photo")} />
              </div>

              {/* Contact */}
              <div className="rounded-lg border border-border px-3 py-2.5 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-foreground">{tr("معلومات التواصل", "Contact")}</label>
                  <Switch checked={data.fields.contact} onCheckedChange={(c) => setField("contact", c)} aria-label={tr("إظهار في السيرة", "Show on CV")} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Input value={phone} onChange={(e) => editPhone(e.target.value)} placeholder={tr("الهاتف", "Phone")} dir="ltr" inputMode="tel" />
                  <Input value={data.email} onChange={(e) => editData((prev) => ({ ...prev, email: e.target.value }))} placeholder={tr("البريد الإلكتروني", "Email")} dir="ltr" type="email" />
                  <Input value={data.address} onChange={(e) => editData((prev) => ({ ...prev, address: e.target.value }))} placeholder={tr("العنوان", "Address")} />
                </div>
              </div>

              {/* Summary */}
              <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-foreground">{tr("نبذة عني", "Summary")}</label>
                  <Switch checked={data.fields.summary} onCheckedChange={(c) => setField("summary", c)} aria-label={tr("إظهار في السيرة", "Show on CV")} />
                </div>
                <Textarea value={data.summary} onChange={(e) => editData((prev) => ({ ...prev, summary: e.target.value }))} rows={3} />
              </div>

              {renderEntries("experience")}
              {renderEntries("education")}

              {/* Skills */}
              <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-foreground">{tr("المهارات", "Skills")}</label>
                  <Switch checked={data.fields.skills} onCheckedChange={(c) => setField("skills", c)} aria-label={tr("إظهار في السيرة", "Show on CV")} />
                </div>
                <TagField
                  values={data.skills}
                  onChange={(v) => editData((prev) => ({ ...prev, skills: v }))}
                  placeholder={tr("أضف مهارة واضغط Enter", "Add a skill, press Enter")}
                  suggestions={SKILL_SUGGESTIONS[data.language]}
                  suggestionsLabel={tr("اقتراحات:", "Suggestions:")}
                  removeLabel={tr("إزالة", "Remove")}
                />
              </div>

              {/* Languages spoken */}
              <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-foreground">{tr("اللغات", "Languages")}</label>
                  <Switch checked={data.fields.languages} onCheckedChange={(c) => setField("languages", c)} aria-label={tr("إظهار في السيرة", "Show on CV")} />
                </div>
                <TagField
                  values={data.languagesSpoken}
                  onChange={(v) => editData((prev) => ({ ...prev, languagesSpoken: v }))}
                  placeholder={tr("مثال: الإنجليزية — متوسط", "e.g. English — Intermediate")}
                  suggestions={LANGUAGE_SUGGESTIONS[data.language]}
                  suggestionsLabel={tr("اقتراحات:", "Suggestions:")}
                  removeLabel={tr("إزالة", "Remove")}
                />
              </div>

              {/* Custom sections */}
              <div className="space-y-3">
                <label className="block text-sm font-semibold text-foreground">{tr("أقسام إضافية", "Custom sections")}</label>
                {data.customSections.map((section, index) => (
                  <div key={section.id} className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                    <Input value={section.title} onChange={(e) => updateSection(section.id, { title: e.target.value })} placeholder={tr("عنوان القسم (مثال: الهوايات، الشهادات)", "Section title (e.g. Hobbies, Certificates)")} />
                    <Textarea value={section.content} onChange={(e) => updateSection(section.id, { content: e.target.value })} placeholder={tr("المحتوى — سطر لكل نقطة", "Content — one line per point")} rows={3} />
                    <RowControls
                      index={index}
                      count={data.customSections.length}
                      isRtl={isRtl}
                      onMove={(dir) => moveSection(index, dir)}
                      onRemove={() => removeSection(section.id)}
                    />
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addSection}>
                  <Icon name="plus" className="w-3.5 h-3.5" />
                  {tr("إضافة قسم", "Add section")}
                </Button>
              </div>
            </div>

            <CvLivePreview html={previewHtml} isRtl={isRtl} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={requestClose}>{tr("إلغاء", "Cancel")}</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? tr("جارٍ الحفظ...", "Saving...") : tr("حفظ", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved changes */}
      <AlertDialog open={discardConfirm} onOpenChange={setDiscardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("تجاهل التغييرات؟", "Discard changes?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("لديك تعديلات غير محفوظة على هذه السيرة. ستضيع إذا أغلقت الآن.", "This CV has unsaved changes. They'll be lost if you close now.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("متابعة التعديل", "Keep editing")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardConfirm(false);
                setDirty(false);
                setDialogOpen(false);
              }}
            >
              {tr("تجاهل", "Discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Print options */}
      <CvPrintDialog
        open={printOptionsOpen}
        isRtl={isRtl}
        defaultPrinterName={shopSettings?.defaultPrinterName || ""}
        submitting={printing}
        onClose={() => setPrintOptionsOpen(false)}
        onPrint={handlePrint}
        onExportPdf={handleExportPdf}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("حذف السيرة الذاتية؟", "Delete CV?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? `سيتم حذف سيرة "${deleteConfirm?.fullName}" نهائيًا. لا يمكن التراجع.`
                : `"${deleteConfirm?.fullName}"'s CV will be permanently deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("إلغاء", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{tr("حذف", "Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CvTool;
