import React, { useState, useEffect } from "react";
import QRCode from "qrcode";
import { Language, Credential, ShopSettings, CredentialSettings, CredentialServicePreset } from "../types";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { activeSocialLinks } from "@atba3li/shared/social";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { errorMessage } from "@atba3li/shared";
import { isElectron, printData, renderHtmlPdf } from "../lib/electronPrint";
import CredentialPrintDialog, { CredentialPrintOptions } from "../components/CredentialPrintDialog";
import { buildCredentialCardHtml, inlineCardAssets } from "../components/credentialCard";

interface CredentialsToolProps {
  lang: Language;
}

interface CredentialForm {
  customerName: string;
  serviceName: string;
  websiteUrl: string;
  username: string;
  password: string;
  notice: string;
}

const EMPTY_FORM: CredentialForm = {
  customerName: "",
  serviceName: "",
  websiteUrl: "",
  username: "",
  password: "",
  notice: "",
};

const CUSTOM_SERVICE = "__custom__";
const EMPTY_CREDENTIAL_SETTINGS: CredentialSettings = { services: [], defaultNotice: "", fontScale: "normal" };

// Not window.open(): under Electron an about:blank popup is handed to the OS
// shell instead of printing — same reasoning as QrPosterDialog.tsx.
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

const CredentialsTool: React.FC<CredentialsToolProps> = ({ lang }) => {
  const isRtl = lang === "ar";

  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [shopSettings, setShopSettings] = useState<ShopSettings | null>(null);
  const [credentialSettings, setCredentialSettings] = useState<CredentialSettings>(EMPTY_CREDENTIAL_SETTINGS);
  const [search, setSearch] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const [serviceChoice, setServiceChoice] = useState<string>(CUSTOM_SERVICE);
  const [saving, setSaving] = useState(false);
  const [revealPassword, setRevealPassword] = useState(true);

  const [deleteConfirm, setDeleteConfirm] = useState<Credential | null>(null);

  const [printCredential, setPrintCredential] = useState<Credential | null>(null);
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Manage services / default notice
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [servicesDraft, setServicesDraft] = useState<CredentialServicePreset[]>([]);
  const [newServiceName, setNewServiceName] = useState("");
  const [newServiceUrl, setNewServiceUrl] = useState("");
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [editServiceName, setEditServiceName] = useState("");
  const [editServiceUrl, setEditServiceUrl] = useState("");
  const [defaultNoticeDraft, setDefaultNoticeDraft] = useState("");
  const [fontScaleDraft, setFontScaleDraft] = useState<CredentialSettings["fontScale"]>("normal");
  const [savingSettings, setSavingSettings] = useState(false);

  const loadCredentials = async () => {
    try {
      setCredentials(await storageService.getCredentials());
    } catch (err) {
      console.error("Failed to load credentials:", err);
      toast({ title: isRtl ? "فشل تحميل البيانات" : "Failed to load credentials", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const loadCredentialSettings = async () => {
    const settings = await storageService.getCredentialSettings();
    setCredentialSettings(settings);
    return settings;
  };

  useEffect(() => {
    loadCredentials();
    loadCredentialSettings();
    storageService.getSettings().then(setShopSettings).catch(() => {});
  }, []);

  const openAddDialog = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setServiceChoice(credentialSettings.services[0]?.id || CUSTOM_SERVICE);
    setRevealPassword(true);
    setDialogOpen(true);
  };

  const openEditDialog = async (cred: Credential) => {
    try {
      const full = await storageService.getCredential(cred.id);
      setEditingId(full.id);
      setForm({
        customerName: full.customerName,
        serviceName: full.serviceName,
        websiteUrl: full.websiteUrl,
        username: full.username,
        password: full.password,
        notice: full.notice,
      });
      const matched = credentialSettings.services.find((s) => s.name === full.serviceName);
      setServiceChoice(matched ? matched.id : CUSTOM_SERVICE);
      setRevealPassword(true);
      setDialogOpen(true);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر فتح البطاقة" : "Could not open the record", description: errorMessage(err), variant: "destructive" });
    }
  };

  const handleServiceChoice = (value: string) => {
    setServiceChoice(value);
    if (value === CUSTOM_SERVICE) return;
    const preset = credentialSettings.services.find((s) => s.id === value);
    if (preset) setForm((prev) => ({ ...prev, serviceName: preset.name, websiteUrl: preset.websiteUrl || prev.websiteUrl }));
  };

  const handleSave = async () => {
    if (!form.customerName.trim() || !form.serviceName.trim() || !form.username.trim() || !form.password.trim()) {
      toast({ title: isRtl ? "الحقول المطلوبة ناقصة" : "Missing required fields", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        customerName: form.customerName.trim(),
        serviceName: form.serviceName.trim(),
        websiteUrl: form.websiteUrl.trim(),
        username: form.username.trim(),
        password: form.password,
        notice: form.notice.trim(),
      };
      if (editingId) {
        await storageService.updateCredential(editingId, payload);
        toast({ title: isRtl ? "تم التحديث" : "Updated", variant: "success" });
      } else {
        await storageService.createCredential(payload);
        toast({ title: isRtl ? "تمت الإضافة" : "Added", variant: "success" });
      }
      setDialogOpen(false);
      loadCredentials();
    } catch (err) {
      toast({ title: isRtl ? "فشل الحفظ" : "Failed to save", description: errorMessage(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await storageService.deleteCredential(deleteConfirm.id);
      toast({ title: isRtl ? "تم الحذف" : "Deleted", variant: "success" });
      loadCredentials();
    } catch (err) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const openPrintDialog = async (cred: Credential) => {
    try {
      const full = await storageService.getCredential(cred.id);
      setPrintCredential(full);
      setPrintOptionsOpen(true);
    } catch (err) {
      toast({ title: isRtl ? "تعذّر فتح البطاقة" : "Could not open the record", description: errorMessage(err), variant: "destructive" });
    }
  };

  const handlePrint = async (opts: CredentialPrintOptions) => {
    if (!printCredential || printing) return;
    setPrinting(true);
    try {
      // SVG, not PNG — same reasoning as the QR poster: it prints crisp at any
      // size instead of pixelating on the larger paper sizes.
      const qrSvg =
        opts.includeWebsite && printCredential.websiteUrl
          ? await QRCode.toString(printCredential.websiteUrl, {
              type: "svg",
              margin: 1,
              errorCorrectionLevel: "M",
              color: { dark: "#0f172a", light: "#ffffff" },
            }).catch(() => "")
          : "";
      const html = await inlineCardAssets(
        buildCredentialCardHtml({
          lang,
          shopSettings,
          credential: printCredential,
          defaultNotice: credentialSettings.defaultNotice,
          fontScale: credentialSettings.fontScale,
          qrSvg,
          options: {
            paperSize: opts.paperSize,
            includeWebsite: opts.includeWebsite,
            includeShopSocial: opts.includeShopSocial,
            includeShopContact: opts.includeShopContact,
            includeNotice: opts.includeNotice,
          },
        }),
      );
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
        throw new Error(isRtl ? "تعذّرت الطباعة" : "Could not print the card");
      }
      setPrintOptionsOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "تعذّرت الطباعة" : "Could not print", description: errorMessage(err), variant: "destructive" });
    } finally {
      setPrinting(false);
    }
  };

  const openSettingsDialog = () => {
    setServicesDraft(credentialSettings.services);
    setDefaultNoticeDraft(credentialSettings.defaultNotice);
    setFontScaleDraft(credentialSettings.fontScale);
    setNewServiceName("");
    setNewServiceUrl("");
    setEditingServiceId(null);
    setSettingsOpen(true);
  };

  const addServiceDraft = () => {
    const name = newServiceName.trim();
    if (!name) return;
    setServicesDraft((prev) => [...prev, { id: `svc_${Date.now().toString(36)}`, name, websiteUrl: newServiceUrl.trim() }]);
    setNewServiceName("");
    setNewServiceUrl("");
  };

  const removeServiceDraft = (id: string) => {
    setServicesDraft((prev) => prev.filter((s) => s.id !== id));
    if (editingServiceId === id) setEditingServiceId(null);
  };

  const startEditServiceDraft = (s: CredentialServicePreset) => {
    setEditingServiceId(s.id);
    setEditServiceName(s.name);
    setEditServiceUrl(s.websiteUrl);
  };

  const cancelEditServiceDraft = () => setEditingServiceId(null);

  const saveEditServiceDraft = () => {
    const name = editServiceName.trim();
    if (!name || !editingServiceId) return;
    const id = editingServiceId;
    setServicesDraft((prev) => prev.map((s) => (s.id === id ? { ...s, name, websiteUrl: editServiceUrl.trim() } : s)));
    setEditingServiceId(null);
  };

  const saveCredentialSettings = async () => {
    setSavingSettings(true);
    try {
      // A name typed into "new service" but never explicitly added with the +
      // button was being silently dropped on Save — fold it in here so typing
      // a name and hitting Save just works.
      const pendingName = newServiceName.trim();
      const finalServices = pendingName
        ? [...servicesDraft, { id: `svc_${Date.now().toString(36)}`, name: pendingName, websiteUrl: newServiceUrl.trim() }]
        : servicesDraft;
      const saved = await storageService.updateCredentialSettings({
        services: finalServices,
        defaultNotice: defaultNoticeDraft.trim(),
        fontScale: fontScaleDraft,
      });
      setCredentialSettings(saved);
      setNewServiceName("");
      setNewServiceUrl("");
      toast({ title: isRtl ? "تم حفظ الإعدادات" : "Settings saved", variant: "success" });
      setSettingsOpen(false);
    } catch (err) {
      toast({ title: isRtl ? "فشل الحفظ" : "Failed to save", description: errorMessage(err), variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };

  const hasShopSocial = activeSocialLinks(shopSettings?.socialLinks).length > 0;
  const hasShopContact = !!(shopSettings?.phoneNumbers?.some(Boolean) || shopSettings?.email);

  // Free-text match across every field the list actually holds. Password is
  // excluded on purpose — the list endpoint only ever has it masked
  // ("••••••••"), so searching it would mean decrypting every record just to
  // filter, defeating the point of masking it in the first place.
  const searchQuery = search.trim().toLowerCase();
  const filteredCredentials = searchQuery
    ? credentials.filter((c) =>
        [c.customerName, c.serviceName, c.username, c.websiteUrl, c.notice].some((field) =>
          (field || "").toLowerCase().includes(searchQuery),
        ),
      )
    : credentials;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">
            {isRtl ? "حسابات الزبائن" : "Customer Accounts"}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            {isRtl
              ? "احفظ بيانات حساب العميل واطبعها على بطاقة أنيقة"
              : "Save a customer's account details and print them as a tidy card"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={openSettingsDialog} className="gap-2" title={isRtl ? "الإعدادات" : "Settings"}>
            <Icon name="settings" className="w-4 h-4" />
            {isRtl ? "الإعدادات" : "Settings"}
          </Button>
          <Button onClick={openAddDialog} className="gap-2">
            <Icon name="plus" className="w-4 h-4" />
            {isRtl ? "إضافة" : "Add"}
          </Button>
        </div>
      </div>

      {!loading && credentials.length > 0 && (
        <div className="relative mb-4">
          <Icon name="search" className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isRtl ? "بحث بالاسم أو الخدمة أو اسم المستخدم أو الموقع أو الملاحظة..." : "Search by name, service, username, website, notice..."}
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
      ) : credentials.length === 0 ? (
        <div className="p-12 text-center bg-card rounded-2xl border border-border">
          <Icon name="key" className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-muted-foreground">{isRtl ? "لا توجد بطاقات بعد" : "No customer accounts yet"}</p>
          <Button variant="outline" onClick={openAddDialog} className="mt-4 gap-2">
            <Icon name="plus" className="w-4 h-4" />
            {isRtl ? "إضافة أول بطاقة" : "Add your first card"}
          </Button>
        </div>
      ) : filteredCredentials.length === 0 ? (
        <div className="p-12 text-center bg-card rounded-2xl border border-border">
          <Icon name="search" className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-muted-foreground">{isRtl ? "لا نتائج مطابقة" : "No matches"}</p>
        </div>
      ) : (
        <Card className="border-0">
          <CardContent className="p-0">
            <div className="divide-y divide-gray-100 dark:divide-white/10">
              {filteredCredentials.map((cred) => (
                <div key={cred.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{cred.customerName}</span>
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                        {cred.serviceName}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {cred.username} <span className="mx-1">·</span> {cred.password}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="outline" size="sm" className="text-xs h-8 px-2.5 gap-1" onClick={() => openPrintDialog(cred)}>
                      <Icon name="print" className="w-3 h-3" />
                      {isRtl ? "طباعة" : "Print"}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title={isRtl ? "تعديل" : "Edit"} onClick={() => openEditDialog(cred)} aria-label={isRtl ? "تعديل" : "Edit"}>
                      <Icon name="edit" className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title={isRtl ? "حذف" : "Delete"} onClick={() => setDeleteConfirm(cred)} aria-label={isRtl ? "حذف" : "Delete"}>
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
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? (isRtl ? "تعديل البطاقة" : "Edit card") : (isRtl ? "إضافة بطاقة" : "Add card")}</DialogTitle>
            <DialogDescription>
              {isRtl ? "بيانات العميل والحساب التي ستُطبع على البطاقة." : "The customer and account details that will print on the card."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "اسم العميل" : "Customer name"}</label>
              <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
            </div>

            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "الخدمة" : "Service"}</label>
              <Select value={serviceChoice} onValueChange={handleServiceChoice}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {credentialSettings.services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_SERVICE}>{isRtl ? "أخرى (اكتب يدويًا)" : "Other (type below)"}</SelectItem>
                </SelectContent>
              </Select>
              {serviceChoice === CUSTOM_SERVICE && (
                <Input
                  className="mt-2"
                  value={form.serviceName}
                  onChange={(e) => setForm({ ...form, serviceName: e.target.value })}
                  placeholder={isRtl ? "مثال: CNAS، Gmail" : "e.g. CNAS, Gmail"}
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {isRtl ? "أضف خدمات جديدة للقائمة من زر الإعدادات." : "Add new services to the list from the Settings button."}
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "رابط الموقع (اختياري)" : "Website (optional)"}</label>
              <Input
                value={form.websiteUrl}
                onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })}
                placeholder="https://..."
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "اسم المستخدم" : "Username"}</label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "كلمة المرور" : "Password"}</label>
                <div className="flex gap-2">
                  <Input
                    type={revealPassword ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={() => setRevealPassword((v) => !v)} aria-label={isRtl ? "إظهار/إخفاء" : "Show/hide"}>
                    <Icon name={revealPassword ? "eye-off" : "eye"} className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">
                {isRtl ? "ملاحظة خاصة بهذه البطاقة (اختياري)" : "Notice for this card only (optional)"}
              </label>
              <Textarea
                value={form.notice}
                onChange={(e) => setForm({ ...form, notice: e.target.value })}
                placeholder={
                  credentialSettings.defaultNotice
                    ? isRtl
                      ? "اتركه فارغًا لاستخدام الملاحظة الافتراضية من الإعدادات"
                      : "Leave empty to use the default notice from Settings"
                    : isRtl
                      ? "مثال: يرجى تغيير كلمة المرور بعد أول تسجيل دخول"
                      : "e.g. Please change your password after first login"
                }
                rows={3}
              />
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
      <CredentialPrintDialog
        open={printOptionsOpen}
        isRtl={isRtl}
        defaultPrinterName={shopSettings?.defaultPrinterName || ""}
        hasWebsite={!!printCredential?.websiteUrl}
        hasShopSocial={hasShopSocial}
        hasShopContact={hasShopContact}
        hasDefaultNotice={!printCredential?.notice && !!credentialSettings.defaultNotice}
        submitting={printing}
        onClose={() => setPrintOptionsOpen(false)}
        onPrint={handlePrint}
      />

      {/* Manage services + default notice */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isRtl ? "إعدادات حسابات الزبائن" : "Customer Accounts settings"}</DialogTitle>
            <DialogDescription>
              {isRtl
                ? "قائمة الخدمات الجاهزة والملاحظة الافتراضية التي تُطبع على كل البطاقات."
                : "Reusable service presets and the default notice printed on every card."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "الخدمات" : "Services"}</label>
              <div className="space-y-1.5 mb-2">
                {servicesDraft.length === 0 && (
                  <p className="text-xs text-muted-foreground">{isRtl ? "لا توجد خدمات محفوظة بعد" : "No saved services yet"}</p>
                )}
                {servicesDraft.map((s) =>
                  editingServiceId === s.id ? (
                    <div key={s.id} className="rounded-lg border border-indigo-300 dark:border-indigo-700 px-3 py-2 space-y-2">
                      <Input
                        value={editServiceName}
                        onChange={(e) => setEditServiceName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditServiceDraft(); } if (e.key === "Escape") cancelEditServiceDraft(); }}
                        placeholder={isRtl ? "اسم الخدمة" : "Service name"}
                        autoFocus
                      />
                      <Input
                        value={editServiceUrl}
                        onChange={(e) => setEditServiceUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEditServiceDraft(); } if (e.key === "Escape") cancelEditServiceDraft(); }}
                        placeholder={isRtl ? "رابط الموقع (اختياري)" : "Website (optional)"}
                        dir="ltr"
                      />
                      <div className="flex justify-end gap-1.5">
                        <Button type="button" variant="outline" size="sm" onClick={cancelEditServiceDraft}>
                          {isRtl ? "إلغاء" : "Cancel"}
                        </Button>
                        <Button type="button" size="sm" onClick={saveEditServiceDraft} disabled={!editServiceName.trim()}>
                          {isRtl ? "تم" : "Done"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                      <div className="min-w-0">
                        <span className="text-sm block">{s.name}</span>
                        {s.websiteUrl && (
                          <span className="text-xs text-muted-foreground truncate block" dir="ltr">{s.websiteUrl}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditServiceDraft(s)} aria-label={isRtl ? "تعديل" : "Edit"}>
                          <Icon name="edit" className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeServiceDraft(s.id)} aria-label={isRtl ? "حذف" : "Remove"}>
                          <Icon name="trash" className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ),
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  value={newServiceName}
                  onChange={(e) => setNewServiceName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addServiceDraft(); } }}
                  placeholder={isRtl ? "اسم خدمة جديدة" : "New service name"}
                />
                <div className="flex gap-2">
                  <Input
                    value={newServiceUrl}
                    onChange={(e) => setNewServiceUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addServiceDraft(); } }}
                    placeholder={isRtl ? "رابط الموقع (اختياري)" : "Website (optional)"}
                    dir="ltr"
                  />
                  <Button type="button" variant="outline" onClick={addServiceDraft}>
                    <Icon name="plus" className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-border">
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "حجم الخط على البطاقة" : "Card text size"}</label>
              <Select value={fontScaleDraft} onValueChange={(v) => setFontScaleDraft(v as CredentialSettings["fontScale"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">{isRtl ? "عادي" : "Normal"}</SelectItem>
                  <SelectItem value="large">{isRtl ? "كبير" : "Large"}</SelectItem>
                  <SelectItem value="xlarge">{isRtl ? "كبير جدًا" : "Extra large"}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {isRtl ? "مفيد خاصة عند الطباعة على A4/A5 حتى لا تبدو البطاقة فارغة." : "Useful on A4/A5 so the card doesn't look sparse on the full sheet."}
              </p>
            </div>

            <div className="pt-2 border-t border-border">
              <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "الملاحظة الافتراضية" : "Default notice"}</label>
              <Textarea
                value={defaultNoticeDraft}
                onChange={(e) => setDefaultNoticeDraft(e.target.value)}
                placeholder={isRtl ? "تُطبع على كل بطاقة لا تملك ملاحظة خاصة بها" : "Printed on every card that has no notice of its own"}
                rows={3}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              {isRtl
                ? "معلومات المتجر (الاسم، الشعار، الهاتف، البريد، حسابات التواصل) تُدار من الإعدادات العامة للمتجر وتظهر تلقائيًا على البطاقة."
                : "Shop info (name, logo, phone, email, social accounts) is managed in the shop's own Settings and appears on the card automatically."}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>{isRtl ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={saveCredentialSettings} disabled={savingSettings}>
              {savingSettings ? (isRtl ? "جارٍ الحفظ..." : "Saving...") : (isRtl ? "حفظ" : "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "حذف البطاقة؟" : "Delete card?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? `سيتم حذف بيانات "${deleteConfirm?.customerName}" نهائيًا. لا يمكن التراجع.`
                : `"${deleteConfirm?.customerName}"'s saved credentials will be permanently deleted. This cannot be undone.`}
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

export default CredentialsTool;
