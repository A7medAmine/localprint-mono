import React, { useEffect, useRef, useState } from "react";
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
import { buildCvHtml } from "../components/cvDocument";
import { inlineCardAssets } from "../components/credentialCard";

interface CvToolProps {
  lang: Language;
}

const uid = () => crypto.randomUUID();

const emptyEntry = (): CvEntry => ({ id: uid(), title: "", subtitle: "", period: "", description: "" });
const emptySection = (): CvCustomSection => ({ id: uid(), title: "", content: "" });

const emptyData = (docLang: CvLanguage): CvDocument => ({
  language: docLang,
  templateId: "modern",
  fields: { photo: true, contact: true, summary: true, experience: true, education: true, skills: true, languages: true },
  jobTitle: "",
  email: "",
  address: "",
  summary: "",
  experience: [],
  education: [],
  skills: [],
  languagesSpoken: [],
  customSections: [],
});

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

// Simple add-on-Enter / remove-with-x tag editor, shared by Skills and
// Languages spoken — both are just freeform string lists.
const TagField: React.FC<{ values: string[]; onChange: (v: string[]) => void; placeholder: string; isRtl: boolean }> = ({
  values,
  onChange,
  placeholder,
  isRtl: _isRtl,
}) => {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-muted text-foreground">
            {v}
            <button type="button" onClick={() => onChange(values.filter((_, idx) => idx !== i))} aria-label="remove">
              <Icon name="x" className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={add}>
          <Icon name="plus" className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

const CvTool: React.FC<CvToolProps> = ({ lang }) => {
  const isRtl = lang === "ar";

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
  const [saving, setSaving] = useState(false);
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
      toast({ title: isRtl ? "فشل تحميل البيانات" : "Failed to load CVs", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfiles();
    storageService.getSettings().then(setShopSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => loadProfiles(search.trim() || undefined), 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const resetPhotoState = () => {
    setPhotoFile(null);
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
    setDialogOpen(true);
  };

  const openEditDialog = async (cv: CvProfile) => {
    try {
      const full = await storageService.getCvProfile(cv.id);
      setEditingId(full.id);
      setFullName(full.fullName);
      setPhone(full.phone);
      setData(full.data);
      resetPhotoState();
      if (full.photoFilename) {
        storageService.fetchCvPhotoDataUrl(full.id).then((url) => { if (url) setPhotoPreview(url); }).catch(() => {});
      }
      setDialogOpen(true);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر فتح السيرة" : "Could not open the CV", description: errorMessage(err), variant: "destructive" });
    }
  };

  const onPickPhoto = (file: File | null) => {
    resetPhotoState();
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    if (!fullName.trim()) {
      toast({ title: isRtl ? "الاسم مطلوب" : "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = { fullName: fullName.trim(), phone: phone.trim(), data };
      const saved = editingId
        ? await storageService.updateCvProfile(editingId, payload)
        : await storageService.createCvProfile(payload);
      if (photoFile) {
        await storageService.uploadCvPhoto(saved.id, photoFile);
      }
      toast({ title: editingId ? (isRtl ? "تم التحديث" : "Updated") : (isRtl ? "تمت الإضافة" : "Added"), variant: "success" });
      setDialogOpen(false);
      loadProfiles(search.trim() || undefined);
    } catch (err) {
      toast({ title: isRtl ? "فشل الحفظ" : "Failed to save", description: errorMessage(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await storageService.deleteCvProfile(deleteConfirm.id);
      toast({ title: isRtl ? "تم الحذف" : "Deleted", variant: "success" });
      loadProfiles(search.trim() || undefined);
    } catch (err) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", description: errorMessage(err), variant: "destructive" });
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
      toast({ title: isRtl ? "تعذّر فتح السيرة" : "Could not open the CV", description: errorMessage(err), variant: "destructive" });
    }
  };

  const buildHtml = async (cv: CvProfile) => {
    const photoDataUrl = cv.data.fields.photo && cv.photoFilename ? await storageService.fetchCvPhotoDataUrl(cv.id) : null;
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
        throw new Error(isRtl ? "تعذّرت الطباعة" : "Could not print the CV");
      }
      setPrintOptionsOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "تعذّرت الطباعة" : "Could not print", description: errorMessage(err), variant: "destructive" });
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
      downloadBlob(pdf, `${printCv.fullName || "cv"}.pdf`);
      setPrintOptionsOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "فشل التصدير" : "Export failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  const setField = <K extends keyof CvDocument["fields"]>(key: K, value: boolean) =>
    setData((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));

  const updateEntry = (list: "experience" | "education", id: string, patch: Partial<CvEntry>) =>
    setData((prev) => ({ ...prev, [list]: prev[list].map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  const addEntry = (list: "experience" | "education") =>
    setData((prev) => ({ ...prev, [list]: [...prev[list], emptyEntry()] }));

  const removeEntry = (list: "experience" | "education", id: string) =>
    setData((prev) => ({ ...prev, [list]: prev[list].filter((e) => e.id !== id) }));

  const updateSection = (id: string, patch: Partial<CvCustomSection>) =>
    setData((prev) => ({ ...prev, customSections: prev.customSections.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSection = () => setData((prev) => ({ ...prev, customSections: [...prev.customSections, emptySection()] }));
  const removeSection = (id: string) => setData((prev) => ({ ...prev, customSections: prev.customSections.filter((s) => s.id !== id) }));

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">{isRtl ? "السير الذاتية" : "CVs"}</h2>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            {isRtl ? "أنشئ سيرة ذاتية للعميل واحفظها لإعادة الطباعة لاحقًا" : "Build a customer's CV and save it to reprint later"}
          </p>
        </div>
        <Button onClick={openAddDialog} className="gap-2 shrink-0">
          <Icon name="plus" className="w-4 h-4" />
          {isRtl ? "إضافة" : "New CV"}
        </Button>
      </div>

      {!loading && profiles.length > 0 && (
        <div className="relative mb-4">
          <Icon name="search" className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isRtl ? "بحث بالاسم أو الهاتف..." : "Search by name or phone..."}
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
          <Icon name="user" className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-muted-foreground">{isRtl ? "لا توجد سير ذاتية بعد" : "No CVs yet"}</p>
          <Button variant="outline" onClick={openAddDialog} className="mt-4 gap-2">
            <Icon name="plus" className="w-4 h-4" />
            {isRtl ? "إنشاء أول سيرة ذاتية" : "Create your first CV"}
          </Button>
        </div>
      ) : (
        <Card className="border-0">
          <CardContent className="p-0">
            <div className="divide-y divide-gray-100 dark:divide-white/10">
              {profiles.map((cv) => (
                <div key={cv.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{cv.fullName}</span>
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                        {DOC_LANG_LABELS[cv.data.language][isRtl ? "ar" : "en"]}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{cv.phone || (isRtl ? "بدون رقم هاتف" : "No phone")}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="outline" size="sm" className="text-xs h-8 px-2.5 gap-1" onClick={() => openPrintDialog(cv)}>
                      <Icon name="print" className="w-3 h-3" />
                      {isRtl ? "طباعة" : "Print"}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title={isRtl ? "تعديل" : "Edit"} onClick={() => openEditDialog(cv)} aria-label={isRtl ? "تعديل" : "Edit"}>
                      <Icon name="edit" className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title={isRtl ? "حذف" : "Delete"} onClick={() => setDeleteConfirm(cv)} aria-label={isRtl ? "حذف" : "Delete"}>
                      <Icon name="trash" className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? (isRtl ? "تعديل السيرة الذاتية" : "Edit CV") : (isRtl ? "سيرة ذاتية جديدة" : "New CV")}</DialogTitle>
            <DialogDescription>
              {isRtl ? "فعّل/عطّل الأقسام حسب الحاجة، وأضف أقسامًا خاصة إن أردت." : "Toggle sections on or off as needed, and add custom sections of your own."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "لغة المستند" : "Document language"}</label>
                <Select value={data.language} onValueChange={(v) => setData((prev) => ({ ...prev, language: v as CvLanguage }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["ar", "en", "fr"] as CvLanguage[]).map((l) => (
                      <SelectItem key={l} value={l}>{DOC_LANG_LABELS[l][isRtl ? "ar" : "en"]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "التصميم" : "Template"}</label>
                <Select value={data.templateId} onValueChange={(v) => setData((prev) => ({ ...prev, templateId: v as CvTemplateId }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["modern", "classic", "minimal", "azure"] as CvTemplateId[]).map((t) => (
                      <SelectItem key={t} value={t}>{TEMPLATE_LABELS[t][isRtl ? "ar" : "en"]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "الاسم الكامل" : "Full name"}</label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "المسمى الوظيفي" : "Job title"}</label>
                <Input value={data.jobTitle} onChange={(e) => setData((prev) => ({ ...prev, jobTitle: e.target.value }))} />
              </div>
            </div>

            {/* Photo */}
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-full bg-muted overflow-hidden flex items-center justify-center shrink-0">
                  {photoPreview ? <img src={photoPreview} alt="" className="w-full h-full object-cover" /> : <Icon name="camera" className="w-5 h-5 text-muted-foreground" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{isRtl ? "الصورة الشخصية" : "Photo"}</p>
                  <button type="button" className="text-xs text-indigo-600 dark:text-indigo-400 underline" onClick={() => fileInputRef.current?.click()}>
                    {isRtl ? "اختر صورة" : "Choose photo"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onPickPhoto(e.target.files?.[0] || null)}
                  />
                </div>
              </div>
              <Switch checked={data.fields.photo} onCheckedChange={(c) => setField("photo", c)} />
            </div>

            {/* Contact */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "معلومات التواصل" : "Contact"}</label>
                <Switch checked={data.fields.contact} onCheckedChange={(c) => setField("contact", c)} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={isRtl ? "الهاتف" : "Phone"} dir="ltr" />
                <Input value={data.email} onChange={(e) => setData((prev) => ({ ...prev, email: e.target.value }))} placeholder={isRtl ? "البريد الإلكتروني" : "Email"} dir="ltr" />
                <Input value={data.address} onChange={(e) => setData((prev) => ({ ...prev, address: e.target.value }))} placeholder={isRtl ? "العنوان" : "Address"} />
              </div>
            </div>

            {/* Summary */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "نبذة عني" : "Summary"}</label>
                <Switch checked={data.fields.summary} onCheckedChange={(c) => setField("summary", c)} />
              </div>
              <Textarea value={data.summary} onChange={(e) => setData((prev) => ({ ...prev, summary: e.target.value }))} rows={3} />
            </div>

            {/* Experience */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "الخبرة المهنية" : "Experience"}</label>
                <Switch checked={data.fields.experience} onCheckedChange={(c) => setField("experience", c)} />
              </div>
              {data.experience.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <Input value={entry.title} onChange={(e) => updateEntry("experience", entry.id, { title: e.target.value })} placeholder={isRtl ? "المسمى الوظيفي" : "Job title"} />
                    <Input value={entry.subtitle} onChange={(e) => updateEntry("experience", entry.id, { subtitle: e.target.value })} placeholder={isRtl ? "الشركة" : "Company"} />
                    <Input value={entry.period} onChange={(e) => updateEntry("experience", entry.id, { period: e.target.value })} placeholder={isRtl ? "الفترة" : "Period"} />
                  </div>
                  <Textarea value={entry.description} onChange={(e) => updateEntry("experience", entry.id, { description: e.target.value })} placeholder={isRtl ? "وصف مختصر" : "Short description"} rows={2} />
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="sm" className="text-xs gap-1" onClick={() => removeEntry("experience", entry.id)}>
                      <Icon name="trash" className="w-3.5 h-3.5" />
                      {isRtl ? "إزالة" : "Remove"}
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => addEntry("experience")}>
                <Icon name="plus" className="w-3.5 h-3.5" />
                {isRtl ? "إضافة خبرة" : "Add experience"}
              </Button>
            </div>

            {/* Education */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "التعليم" : "Education"}</label>
                <Switch checked={data.fields.education} onCheckedChange={(c) => setField("education", c)} />
              </div>
              {data.education.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <Input value={entry.title} onChange={(e) => updateEntry("education", entry.id, { title: e.target.value })} placeholder={isRtl ? "الشهادة" : "Degree"} />
                    <Input value={entry.subtitle} onChange={(e) => updateEntry("education", entry.id, { subtitle: e.target.value })} placeholder={isRtl ? "المؤسسة" : "School"} />
                    <Input value={entry.period} onChange={(e) => updateEntry("education", entry.id, { period: e.target.value })} placeholder={isRtl ? "الفترة" : "Period"} />
                  </div>
                  <Textarea value={entry.description} onChange={(e) => updateEntry("education", entry.id, { description: e.target.value })} placeholder={isRtl ? "وصف مختصر" : "Short description"} rows={2} />
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="sm" className="text-xs gap-1" onClick={() => removeEntry("education", entry.id)}>
                      <Icon name="trash" className="w-3.5 h-3.5" />
                      {isRtl ? "إزالة" : "Remove"}
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => addEntry("education")}>
                <Icon name="plus" className="w-3.5 h-3.5" />
                {isRtl ? "إضافة تعليم" : "Add education"}
              </Button>
            </div>

            {/* Skills */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "المهارات" : "Skills"}</label>
                <Switch checked={data.fields.skills} onCheckedChange={(c) => setField("skills", c)} />
              </div>
              <TagField values={data.skills} onChange={(v) => setData((prev) => ({ ...prev, skills: v }))} placeholder={isRtl ? "أضف مهارة واضغط Enter" : "Add a skill, press Enter"} isRtl={isRtl} />
            </div>

            {/* Languages spoken */}
            <div className="rounded-lg border border-border px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground">{isRtl ? "اللغات" : "Languages"}</label>
                <Switch checked={data.fields.languages} onCheckedChange={(c) => setField("languages", c)} />
              </div>
              <TagField values={data.languagesSpoken} onChange={(v) => setData((prev) => ({ ...prev, languagesSpoken: v }))} placeholder={isRtl ? "مثال: الإنجليزية — متوسط" : "e.g. English — Intermediate"} isRtl={isRtl} />
            </div>

            {/* Custom sections */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-foreground">{isRtl ? "أقسام إضافية" : "Custom sections"}</label>
              {data.customSections.map((section) => (
                <div key={section.id} className="rounded-lg border border-border px-3 py-2.5 space-y-2">
                  <Input value={section.title} onChange={(e) => updateSection(section.id, { title: e.target.value })} placeholder={isRtl ? "عنوان القسم" : "Section title"} />
                  <Textarea value={section.content} onChange={(e) => updateSection(section.id, { content: e.target.value })} placeholder={isRtl ? "المحتوى" : "Content"} rows={3} />
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="sm" className="text-xs gap-1" onClick={() => removeSection(section.id)}>
                      <Icon name="trash" className="w-3.5 h-3.5" />
                      {isRtl ? "إزالة" : "Remove"}
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addSection}>
                <Icon name="plus" className="w-3.5 h-3.5" />
                {isRtl ? "إضافة قسم" : "Add section"}
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{isRtl ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (isRtl ? "جارٍ الحفظ..." : "Saving...") : (isRtl ? "حفظ" : "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <AlertDialogTitle>{isRtl ? "حذف السيرة الذاتية؟" : "Delete CV?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? `سيتم حذف سيرة "${deleteConfirm?.fullName}" نهائيًا. لا يمكن التراجع.`
                : `"${deleteConfirm?.fullName}"'s CV will be permanently deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{isRtl ? "حذف" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CvTool;
