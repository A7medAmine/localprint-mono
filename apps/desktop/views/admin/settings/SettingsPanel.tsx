import React, { useEffect, useState } from "react";
import { DiscountRule, DiscountType, ConditionType, PaperType, ShopSettings } from "../../../types";
import { storageService } from "../../../services/storageService";
import { cn } from "@atba3li/shared";
import { toast } from "../../../components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import QrPosterDialog from "../../../components/QrPosterDialog";
import { useAdmin } from "../AdminContext";
import { PasswordCard } from "./PasswordCard";
import { BackupCard } from "./BackupCard";
import { PrintersCard } from "./PrintersCard";
import { Icon } from "../../../components/ui/icon";
import { errorMessage } from "@atba3li/shared";
import type { ShopLocation } from "@atba3li/shared/geo";
import { directionsUrl } from "@atba3li/shared/geo";
import LocationPicker from "@atba3li/shared/components/map/LocationPicker";
import type { SocialLinks } from "@atba3li/shared/social";
import { SOCIAL_PLATFORMS, MAX_DESCRIPTION_LENGTH } from "@atba3li/shared/social";
import { SocialIcon } from "@atba3li/shared/components/StoreSocialLinks";

interface JobStats {
  pending: number;
  ready: number;
  printed: number;
  customers: number;
}

interface SettingsPanelProps {
  /** Discount rules live in AdminView (job cost calc needs them). */
  discountRules: DiscountRule[];
  /** Re-fetch discount rules after a create / update / delete. */
  onRulesChanged: () => void;
  jobStats: JobStats;
  onManageInventory: () => void;
}

const PAPER_TYPE_FALLBACK = (pricing: ShopSettings["pricing"]): PaperType[] => [
  { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: pricing?.colorPerPage || 30.0, blackWhitePerPage: pricing?.blackWhitePerPage || 15.0 },
  { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: pricing?.glossyPerPage || 50.0, blackWhitePerPage: pricing?.glossyPerPage || 50.0 },
  { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: pricing?.cardboardPerPage || 40.0, blackWhitePerPage: pricing?.cardboardPerPage || 40.0 },
];

const SettingsPanel: React.FC<SettingsPanelProps> = ({ discountRules, onRulesChanged, jobStats, onManageInventory }) => {
  const { t, isRtl, lang, settings, onSettingsUpdate } = useAdmin();
  const currentSettings = settings;

  const [shopName, setShopName] = useState(currentSettings.shopName);
  const [logoUrl, setLogoUrl] = useState<string | null>(currentSettings.logoUrl);
  const [currency, setCurrency] = useState(currentSettings.currency || "");
  // Which section is mid-save — drives the per-section button spinners/disabled
  // state. Each card owns its own Save now; there is no global save.
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [paperTypes, setPaperTypes] = useState<PaperType[]>(
    currentSettings.paperTypes && currentSettings.paperTypes.length > 0
      ? currentSettings.paperTypes
      : PAPER_TYPE_FALLBACK(currentSettings.pricing),
  );
  const [editingPaperTypeId, setEditingPaperTypeId] = useState<string | null>(null);
  const [editingPaperTypeForm, setEditingPaperTypeForm] = useState<{ name: string; nameAr: string; colorPerPage: number; blackWhitePerPage: number } | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>(currentSettings.phoneNumbers || []);
  const [email, setEmail] = useState(currentSettings.email || "");
  const [address, setAddress] = useState(currentSettings.address || "");
  const [workingHours, setWorkingHours] = useState(currentSettings.workingHours || "");
  const [returnPolicy, setReturnPolicy] = useState(currentSettings.returnPolicy || "");
  const [description, setDescription] = useState(currentSettings.description || "");
  const [socialLinks, setSocialLinks] = useState<SocialLinks>(currentSettings.socialLinks || {});
  const [location, setLocation] = useState<ShopLocation | null>(currentSettings.location ?? null);
  const [locationOpen, setLocationOpen] = useState(false);
  const [showAddPaperTypeForm, setShowAddPaperTypeForm] = useState(false);
  const [newPaperTypeForm, setNewPaperTypeForm] = useState({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 });
  const [cloudSyncUrl, setCloudSyncUrl] = useState(currentSettings.cloudSyncUrl || "");
  const [cloudShopSlug, setCloudShopSlug] = useState(currentSettings.cloudShopSlug || "");
  const [shopApiToken, setShopApiToken] = useState(currentSettings.shopApiToken || "");
  const [cloudSyncPollInterval, setCloudSyncPollInterval] = useState(currentSettings.cloudSyncPollInterval || "30000");
  const [autoAcceptCloudJobs, setAutoAcceptCloudJobs] = useState(currentSettings.autoAcceptCloudJobs !== false);
  const [autoDeductStock, setAutoDeductStock] = useState(currentSettings.autoDeductStock === true);
  // "draft" tests the fields as typed, "saved" tests what the server has stored.
  const [cloudTesting, setCloudTesting] = useState<null | "draft" | "saved">(null);
  const [cloudTestResult, setCloudTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [qrPosterOpen, setQrPosterOpen] = useState(false);
  const [isEditingRule, setIsEditingRule] = useState(false);
  const [editingRule, setEditingRule] = useState<DiscountRule | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleFormData, setRuleFormData] = useState<Partial<DiscountRule>>({
    name: "",
    discount_type: "percent",
    discount_value: 10,
    condition_type: "pages",
    threshold: 50,
    max_discount_cap: null,
    priority: 0,
    is_active: true,
  });
  const [deleteRuleConfirm, setDeleteRuleConfirm] = useState<string | null>(null);

  // Re-sync the draft when the SAVED settings change — initial load, a cloud
  // settings pull, a logo upload, or (now that each card saves on its own) a
  // sibling section's save. Only adopt the incoming value for a field the user
  // hasn't edited since the last sync, so saving one section never wipes out
  // another section's in-progress edits.
  const prevSyncedRef = React.useRef<typeof currentSettings | null>(null);
  useEffect(() => {
    const prev = prevSyncedRef.current;
    // "clean" = the draft still matches what we last synced, i.e. untouched.
    const clean = (local: unknown, prevVal: unknown) =>
      prev === null || JSON.stringify(local) === JSON.stringify(prevVal);

    if (clean(shopName, prev?.shopName)) setShopName(currentSettings.shopName);
    if (clean(logoUrl, prev?.logoUrl ?? null)) setLogoUrl(currentSettings.logoUrl);
    if (clean(currency, prev?.currency ?? "")) setCurrency(currentSettings.currency || "");
    if (currentSettings.paperTypes && currentSettings.paperTypes.length > 0 && clean(paperTypes, prev?.paperTypes)) {
      setPaperTypes(currentSettings.paperTypes);
    }
    if (clean(phoneNumbers, prev?.phoneNumbers ?? [])) setPhoneNumbers(currentSettings.phoneNumbers || []);
    if (clean(email, prev?.email ?? "")) setEmail(currentSettings.email || "");
    if (clean(address, prev?.address ?? "")) setAddress(currentSettings.address || "");
    if (clean(workingHours, prev?.workingHours ?? "")) setWorkingHours(currentSettings.workingHours || "");
    if (clean(returnPolicy, prev?.returnPolicy ?? "")) setReturnPolicy(currentSettings.returnPolicy || "");
    if (clean(description, prev?.description ?? "")) setDescription(currentSettings.description || "");
    if (clean(socialLinks, prev?.socialLinks ?? {})) setSocialLinks(currentSettings.socialLinks || {});
    if (clean(location, prev?.location ?? null)) setLocation(currentSettings.location ?? null);
    if (clean(cloudSyncUrl, prev?.cloudSyncUrl ?? "")) setCloudSyncUrl(currentSettings.cloudSyncUrl || "");
    if (clean(cloudShopSlug, prev?.cloudShopSlug ?? "")) setCloudShopSlug(currentSettings.cloudShopSlug || "");
    if (clean(shopApiToken, prev?.shopApiToken ?? "")) setShopApiToken(currentSettings.shopApiToken || "");
    if (clean(cloudSyncPollInterval, prev?.cloudSyncPollInterval || "30000")) setCloudSyncPollInterval(currentSettings.cloudSyncPollInterval || "30000");
    if (clean(autoAcceptCloudJobs, prev ? prev.autoAcceptCloudJobs !== false : undefined)) setAutoAcceptCloudJobs(currentSettings.autoAcceptCloudJobs !== false);
    if (clean(autoDeductStock, prev ? prev.autoDeductStock === true : undefined)) setAutoDeductStock(currentSettings.autoDeductStock === true);
    // Printer state lives in PrintersCard, which re-baselines itself.

    prevSyncedRef.current = currentSettings;
  }, [currentSettings]);



  const handleAddRule = () => {
    setIsEditingRule(false);
    setEditingRule(null);
    setRuleFormData({
      name: "",
      discount_type: "percent",
      discount_value: 10,
      condition_type: "pages",
      threshold: 50,
      max_discount_cap: null,
      priority: 0,
      is_active: true,
    });
    setShowRuleForm(true);
  };

  const handleEditRule = (rule: DiscountRule) => {
    setIsEditingRule(true);
    setEditingRule(rule);
    setRuleFormData({ ...rule });
    setShowRuleForm(true);
  };

  const handleSaveRule = async () => {
    try {
      if (!ruleFormData.name || ruleFormData.discount_value === undefined || ruleFormData.threshold === undefined) {
        toast({ title: isRtl ? "يرجى ملء جميع الحقول المطلوبة" : "Please fill all required fields", variant: "destructive" });
        return;
      }
      const ruleData: DiscountRule = {
        id: isEditingRule && editingRule ? editingRule.id : Math.random().toString(36).substring(2, 9),
        name: ruleFormData.name!,
        discount_type: ruleFormData.discount_type as DiscountType,
        discount_value: Number(ruleFormData.discount_value),
        condition_type: ruleFormData.condition_type as ConditionType,
        threshold: Number(ruleFormData.threshold),
        max_discount_cap: ruleFormData.max_discount_cap ? Number(ruleFormData.max_discount_cap) : null,
        priority: Number(ruleFormData.priority) || 0,
        is_active: ruleFormData.is_active !== false,
      };
      if (isEditingRule && editingRule) {
        await storageService.updateDiscountRule(editingRule.id, ruleData);
        toast({ title: isRtl ? "تم تحديث القاعدة بنجاح" : "Rule updated successfully", variant: "success" });
      } else {
        await storageService.createDiscountRule(ruleData);
        toast({ title: isRtl ? "تم إنشاء القاعدة بنجاح" : "Rule created successfully", variant: "success" });
      }
      setShowRuleForm(false);
      onRulesChanged();
    } catch (err) {
      console.error("Failed to save discount rule:", err);
      toast({ title: isRtl ? "فشل حفظ القاعدة" : "Failed to save rule", variant: "destructive" });
    }
  };

  const handleDeleteRule = async (id: string) => {
    setDeleteRuleConfirm(id);
  };

  const confirmDeleteRule = async () => {
    if (deleteRuleConfirm) {
      try {
        await storageService.deleteDiscountRule(deleteRuleConfirm);
        toast({ title: isRtl ? "تم حذف القاعدة بنجاح" : "Rule deleted successfully", variant: "success" });
        onRulesChanged();
      } catch (err) {
        console.error("Failed to delete discount rule:", err);
        toast({ title: isRtl ? "فشل حذف القاعدة" : "Failed to delete rule", variant: "destructive" });
      }
      setDeleteRuleConfirm(null);
    }
  };

  const handleToggleRuleActive = async (rule: DiscountRule) => {
    try {
      await storageService.updateDiscountRule(rule.id, { is_active: !rule.is_active });
      onRulesChanged();
      toast({ title: !rule.is_active ? (isRtl ? "تم تفعيل القاعدة" : "Rule activated") : (isRtl ? "تم تعطيل القاعدة" : "Rule deactivated"), variant: "success" });
    } catch (err) {
      console.error("Failed to toggle rule:", err);
      toast({ title: isRtl ? "فشل تحديث القاعدة" : "Failed to update rule", variant: "destructive" });
    }
  };




  // Paper types persist immediately via the granular /api/paper-types endpoints
  // (create/update/delete) instead of the old bulk settings save, which wiped
  // and rebuilt the whole table — and every inventory link — on every save. Keep
  // the App-level settings in sync so job cost calc / upload see edits at once.
  const syncPaperTypes = (next: PaperType[]) => {
    setPaperTypes(next);
    onSettingsUpdate({ ...currentSettings, paperTypes: next });
  };

  const handleAddPaperType = async () => {
    if (!newPaperTypeForm.name.trim()) return;
    const newPt: PaperType = {
      id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: newPaperTypeForm.name.trim(),
      nameAr: newPaperTypeForm.nameAr.trim() || newPaperTypeForm.name.trim(),
      colorPerPage: newPaperTypeForm.colorPerPage,
      blackWhitePerPage: newPaperTypeForm.blackWhitePerPage,
    };
    try {
      const created = await storageService.createPaperType(newPt);
      syncPaperTypes([...paperTypes, created || newPt]);
      setShowAddPaperTypeForm(false);
      setNewPaperTypeForm({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 });
      toast({ title: isRtl ? "تم إضافة نوع الورق" : "Paper type added", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل إضافة نوع الورق" : "Failed to add paper type", description: errorMessage(err), variant: "destructive" });
    }
  };

  const handleSavePaperType = async (id: string) => {
    if (!editingPaperTypeForm) return;
    try {
      const updated = await storageService.updatePaperType(id, editingPaperTypeForm);
      syncPaperTypes(paperTypes.map((pt) => (pt.id === id ? { ...pt, ...(updated || editingPaperTypeForm) } : pt)));
      setEditingPaperTypeId(null);
      setEditingPaperTypeForm(null);
      toast({ title: isRtl ? "تم حفظ نوع الورق" : "Paper type saved", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل حفظ نوع الورق" : "Failed to save paper type", description: errorMessage(err), variant: "destructive" });
    }
  };

  const handleDeletePaperType = async (id: string) => {
    try {
      await storageService.deletePaperType(id);
      syncPaperTypes(paperTypes.filter((pt) => pt.id !== id));
      toast({ title: isRtl ? "تم حذف نوع الورق" : "Paper type deleted", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل حذف نوع الورق" : "Failed to delete paper type", description: errorMessage(err), variant: "destructive" });
    }
  };

  // Each section persists only its own keys via a partial POST /api/settings
  // (the server guards every field with !== undefined). paperTypes are handled
  // separately by the granular endpoints above, so no section sends them.
  const persistSection = async (
    section: string,
    subset: Parameters<typeof storageService.saveSettings>[0],
  ) => {
    setSavingSection(section);
    try {
      await storageService.saveSettings(subset);
      onSettingsUpdate({ ...currentSettings, ...subset });
      toast({ title: isRtl ? "تم الحفظ بنجاح" : "Saved successfully", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل الحفظ" : "Save failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setSavingSection(null);
    }
  };

  const saveShopInfo = () =>
    persistSection("shop", {
      shopName, currency, phoneNumbers, email, address, workingHours, returnPolicy,
      description, socialLinks, location,
    });
  const saveCloudSync = () =>
    persistSection("cloud", { cloudSyncUrl, cloudShopSlug, shopApiToken, cloudSyncPollInterval, autoAcceptCloudJobs });
  // Round-trip the cloud with either the typed-but-unsaved credentials or the
  // stored ones, so a wrong link/token is caught before it silently breaks
  // order polling. "saved" sends no overrides — the server uses the DB values.
  const runCloudTest = async (mode: "draft" | "saved") => {
    setCloudTesting(mode);
    setCloudTestResult(null);
    try {
      const result = await storageService.testCloudConnection(
        mode === "draft" ? { cloudSyncUrl, shopApiToken } : {},
      );
      if (result.ok) {
        const who = result.shopName || result.shopSlug;
        const text = isRtl
          ? `الاتصال ناجح${who ? ` — ${who}` : ""}`
          : `Connected${who ? ` — ${who}` : ""}`;
        setCloudTestResult({ ok: true, text });
        toast({ title: text, variant: "success" });
        // The cloud owns the slug; adopt it so the QR poster links stay right.
        if (result.shopSlug && result.shopSlug !== cloudShopSlug) setCloudShopSlug(result.shopSlug);
      } else {
        const reasons: Record<string, { en: string; ar: string }> = {
          missing_url: { en: "Enter the store link first.", ar: "أدخل رابط المتجر أولًا." },
          missing_token: { en: "Enter the API token first.", ar: "أدخل رمز API أولًا." },
          timeout: { en: "The server did not answer in 10 seconds.", ar: "لم يستجب الخادم خلال 10 ثوانٍ." },
          unreachable: { en: "Could not reach that address — check the store link.", ar: "تعذّر الوصول إلى العنوان — تحقق من رابط المتجر." },
          bad_token: { en: "The API token was rejected.", ar: "تم رفض رمز API." },
          shop_deactivated: { en: "This shop is deactivated on the cloud.", ar: "هذا المتجر معطّل على السحابة." },
          bad_response: { en: "The address answered, but not like an Atba3li cloud.", ar: "استجاب العنوان لكن ليس كخادم أطبعلي." },
        };
        const known = result.error ? reasons[result.error] : undefined;
        const text = known
          ? (isRtl ? known.ar : known.en)
          : result.message || (isRtl ? `فشل الاتصال (${result.status || "?"})` : `Connection failed (${result.status || "?"})`);
        setCloudTestResult({ ok: false, text });
        toast({ title: isRtl ? "فشل الاتصال" : "Connection failed", description: text, variant: "destructive" });
      }
    } catch (err) {
      const text = errorMessage(err) || (isRtl ? "فشل الاتصال" : "Connection failed");
      setCloudTestResult({ ok: false, text });
      toast({ title: isRtl ? "فشل الاتصال" : "Connection failed", description: text, variant: "destructive" });
    } finally {
      setCloudTesting(null);
    }
  };

  const saveInventory = () => persistSection("inventory", { autoDeductStock });

  // Per-section dirty flags — drive each Save button's enabled state so one
  // section's Save never silently ships another section's half-made edits.
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const shopDirty =
    shopName !== currentSettings.shopName ||
    currency !== (currentSettings.currency || "") ||
    !eq(phoneNumbers, currentSettings.phoneNumbers || []) ||
    email !== (currentSettings.email || "") ||
    address !== (currentSettings.address || "") ||
    workingHours !== (currentSettings.workingHours || "") ||
    returnPolicy !== (currentSettings.returnPolicy || "") ||
    description !== (currentSettings.description || "") ||
    !eq(socialLinks, currentSettings.socialLinks || {}) ||
    !eq(location, currentSettings.location ?? null);
  const cloudDirty =
    cloudSyncUrl !== (currentSettings.cloudSyncUrl || "") ||
    cloudShopSlug !== (currentSettings.cloudShopSlug || "") ||
    shopApiToken !== (currentSettings.shopApiToken || "") ||
    cloudSyncPollInterval !== (currentSettings.cloudSyncPollInterval || "30000") ||
    autoAcceptCloudJobs !== (currentSettings.autoAcceptCloudJobs !== false);
  const inventoryDirty = autoDeductStock !== (currentSettings.autoDeductStock === true);

  const renderSaveBar = (dirty: boolean, section: string, onSave: () => void) => (
    <div className="flex items-center justify-end gap-3 pt-3 mt-1 border-t border-border">
      {dirty && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {isRtl ? "تغييرات غير محفوظة" : "Unsaved changes"}
        </span>
      )}
      <Button onClick={onSave} disabled={!dirty || savingSection === section} size="sm" className="gap-1.5">
        <Icon name="check" className="w-4 h-4" />
        {savingSection === section ? (isRtl ? "جارٍ الحفظ..." : "Saving…") : (isRtl ? "حفظ" : "Save")}
      </Button>
    </div>
  );

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const newLogoUrl = await storageService.uploadLogo(file);
        setLogoUrl(newLogoUrl);
        onSettingsUpdate({ ...currentSettings, logoUrl: newLogoUrl });
        toast({ title: isRtl ? "تم رفع الشعار بنجاح" : "Logo uploaded successfully", variant: "success" });
      } catch {
        toast({ title: isRtl ? "فشل رفع الشعار" : "Failed to upload logo", variant: "destructive" });
      }
    }
  };

  return (
    <>
          <div className="max-w-5xl mx-auto">
            {/* Page Header */}
            <div className="mb-8">
              <h2 className="text-2xl sm:text-3xl font-bold text-foreground">
                {isRtl ? "إعدادات المحل" : "Shop Settings"}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm sm:text-base">
                {isRtl
                  ? "إدارة إعدادات المحل والتسعير"
                  : "Manage your shop configuration and pricing"}
              </p>
            </div>

            {/* Settings Grid — all cards sit in one grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* QR Poster Card — promoted to the top: it's the fastest way for a
                  shop to get customers uploading, so it leads the settings page. */}
              <Card className="lg:col-span-2 border-0 bg-indigo-50/50 dark:bg-indigo-950/20 ring-1 ring-indigo-100 dark:ring-indigo-900/40">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
                      <Icon name="qr" className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? "ملصق QR للمتجر" : "Shop QR Poster"}</CardTitle>
                      <CardDescription>
                        {isRtl
                          ? "أنشئ ملصق A4 بشعار المتجر ورمز QR جاهزًا للطباعة والعرض"
                          : "Generate an A4 poster with your shop branding and QR, ready to print and display"}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p className="text-xs text-muted-foreground max-w-md">
                      {isRtl
                        ? "يمكنك اختيار رابط الشبكة المحلية أو رابط الموقع الإلكتروني قبل الطباعة."
                        : "Pick the local-network link or the online website link before printing."}
                    </p>
                    <Button onClick={() => setQrPosterOpen(true)} className="gap-2 w-full sm:w-auto">
                      <Icon name="print" className="w-4 h-4" />
                      {isRtl ? "فتح ملصق QR" : "Open QR Poster"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Shop Info Card */}
              <Card className="border-0">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
                      <Icon name="building" className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? "معلومات المحل" : "Shop Information"}</CardTitle>
                      <CardDescription>{isRtl ? "الاسم والشعار" : "Name & logo"}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopName")}</label>
                    <Input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder={isRtl ? "اسم المحل" : "Print Shop Name"} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopLogo")}</label>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      {logoUrl ? (
                        <div className="w-20 h-20 rounded-xl border-2 border-white dark:border-gray-700 shadow-md dark:shadow-gray-800/50 overflow-hidden bg-muted flex-shrink-0">
                          <img src={logoUrl} alt="Logo Preview" className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="w-20 h-20 rounded-xl border-2 border-dashed border-border bg-muted/40 flex items-center justify-center flex-shrink-0">
                          <Icon name="file-image" className="w-8 h-8 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 w-full">
                        <Input type="file" accept="image/*" onChange={handleLogoUpload} className="file:me-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 dark:file:bg-indigo-900/30 file:text-indigo-600 dark:file:text-indigo-400 file:hover:bg-indigo-100 dark:file:hover:bg-indigo-900/50 file:cursor-pointer cursor-pointer" />
                        <p className="text-xs text-muted-foreground mt-2">{isRtl ? "PNG, JPG أو GIF (الحد الأقصى 2MB)" : "PNG, JPG or GIF (max 2MB)"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Phone Numbers */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopPhone")}</label>
                    <div className="space-y-2">
                      {phoneNumbers.map((num, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Input value={num} onChange={(e) => { const next = [...phoneNumbers]; next[idx] = e.target.value; setPhoneNumbers(next); }} placeholder={isRtl ? "رقم الهاتف" : "Phone number"} />
                          <button type="button" onClick={() => setPhoneNumbers(phoneNumbers.filter((_, i) => i !== idx))} aria-label={isRtl ? "حذف الرقم" : "Remove number"} className="p-2 text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                            <Icon name="x" className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <Button variant="outline" size="sm" onClick={() => setPhoneNumbers([...phoneNumbers, ""])}>
                        <Icon name="plus" className="w-3.5 h-3.5 me-1" />
                        {t("addPhone")}
                      </Button>
                    </div>
                  </div>

                  {/* Email */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopEmail")}</label>
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={isRtl ? "البريد الإلكتروني" : "shop@example.com"} />
                  </div>

                  {/* Address */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopAddress")}</label>
                    <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={isRtl ? "عنوان المحل" : "123 Main St, City"} />
                  </div>

                  {/* Map location — the pin the cloud directory sorts by */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">
                      {isRtl ? "الموقع على الخريطة" : "Map location"}
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                        {location ? (
                          <span dir="ltr" className="font-mono text-xs">
                            {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {isRtl ? "لم يتم تحديد موقع" : "Not set"}
                          </span>
                        )}
                      </div>
                      <Button type="button" variant="outline" onClick={() => setLocationOpen(true)}>
                        <Icon name="map-pin" className="h-4 w-4" />
                        {location ? (isRtl ? "تعديل" : "Change") : (isRtl ? "تحديد" : "Set")}
                      </Button>
                      {location && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => window.open(directionsUrl(location) || "", "_blank", "noopener")}
                        >
                          {isRtl ? "عرض" : "Open"}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {isRtl
                        ? "يظهر على صفحة المحل ويُستعمل لإيجاد أقرب محل للزبون."
                        : "Shown on your storefront and used to find the nearest shop to a customer."}
                    </p>
                  </div>

                  {/* Working Hours */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopWorkingHours")}</label>
                    <Input value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} placeholder={isRtl ? "ساعات العمل" : "Sat-Thu 9:00-18:00"} />
                  </div>

                  {/* Return Policy */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{t("shopReturnPolicy")}</label>
                    <textarea value={returnPolicy} onChange={(e) => setReturnPolicy(e.target.value)} rows={3} className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 resize-y" placeholder={isRtl ? "سياسة الإرجاع" : "Return policy details..."} />
                  </div>

                  {/* Store description — the blurb on the cloud storefront card
                      and at the foot of the upload page. */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">
                      {isRtl ? "وصف المحل" : "Store description"}
                    </label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LENGTH))}
                      rows={3}
                      maxLength={MAX_DESCRIPTION_LENGTH}
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 resize-y"
                      placeholder={isRtl ? "نبذة قصيرة عن المحل وخدماته" : "A short line about your shop and what it prints"}
                    />
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-xs text-muted-foreground">
                        {isRtl
                          ? "يظهر على بطاقة المحل في المنصة وفي أسفل صفحة الرفع."
                          : "Shown on your storefront card and at the bottom of the upload page."}
                      </p>
                      <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
                        {description.length}/{MAX_DESCRIPTION_LENGTH}
                      </span>
                    </div>
                  </div>

                  {/* Social links — one row per platform, all optional. Each
                      field takes the page's own link, copied from the browser;
                      a username is rejected rather than guessed into a URL. */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">
                      {isRtl ? "روابط التواصل الاجتماعي" : "Social links"}
                    </label>
                    <div className="space-y-2">
                      {SOCIAL_PLATFORMS.map((platform) => (
                        <div key={platform.id} className="flex items-center gap-2">
                          <span
                            title={isRtl ? platform.labelAr : platform.label}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                          >
                            <SocialIcon id={platform.id} className="h-4 w-4" />
                          </span>
                          <Input
                            dir="ltr"
                            value={socialLinks[platform.id] || ""}
                            onChange={(e) =>
                              setSocialLinks({ ...socialLinks, [platform.id]: e.target.value })
                            }
                            placeholder={platform.placeholder}
                            aria-label={isRtl ? platform.labelAr : platform.label}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {isRtl
                        ? "الصق رابط الصفحة كاملًا (وليس اسم المستخدم). اترك الحقل فارغًا إذا لم يكن لديك حساب — تُنشر الحقول المملوءة فقط."
                        : "Paste the full link to the page, not a username. Leave a field empty if you don't have that account — only filled ones are published."}
                    </p>
                  </div>

                  {/* Currency */}
                  <div>
                    <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "العملة" : "Currency"}</label>
                    <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder={isRtl ? "مثال: DZD" : "e.g. DZD"} />
                    <p className="text-xs text-muted-foreground mt-1">{isRtl ? "تظهر بجانب الأسعار في جميع أنحاء التطبيق." : "Shown next to prices across the app."}</p>
                  </div>

                  {renderSaveBar(shopDirty, "shop", saveShopInfo)}
                </CardContent>
              </Card>

              {/* Pricing Card */}
              <Card className="border-0">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center flex-shrink-0">
                      <Icon name="money" className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? "أسعار الطباعة" : "Printing Prices"}</CardTitle>
                      <CardDescription>{isRtl ? "التسعير لكل صفحة" : "Per page pricing"}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold text-foreground">
                      {isRtl ? "أنواع الورق وأسعارها" : "Paper Types & Pricing"}
                    </label>
                    <Button size="sm" onClick={() => { setShowAddPaperTypeForm(true); setEditingPaperTypeId(null); }}>
                      <Icon name="plus" className="w-3.5 h-3.5" />
                      {isRtl ? "إضافة نوع" : "Add Type"}
                    </Button>
                  </div>

                  <div className="overflow-x-auto rounded-xl">
                    <table className="w-full text-sm min-w-[400px]">
                      <thead>
                        <tr className="bg-muted/40 border-b border-border">
                          <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-start">{isRtl ? "نوع الورق" : "Paper Type"}</th>
                          <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-start">{isRtl ? "ملون" : "Color"}</th>
                          <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-start">{isRtl ? "أبيض/أسود" : "B&W"}</th>
                          <th className="px-3 py-2.5 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {paperTypes.map((pt, idx) => (
                          <tr key={pt.id} className={idx < paperTypes.length - 1 ? "border-b border-border" : ""}>
                            {editingPaperTypeId === pt.id && editingPaperTypeForm ? (
                              <>
                                <td className="px-3 py-2">
                                  <Input value={editingPaperTypeForm.name} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, name: e.target.value })} placeholder="EN" className="text-xs mb-1 h-8" />
                                  <Input value={editingPaperTypeForm.nameAr} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, nameAr: e.target.value })} placeholder="AR" className="text-xs h-8" />
                                </td>
                                <td className="px-3 py-2">
                                  <Input type="number" min="0" step="0.5" value={editingPaperTypeForm.colorPerPage} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, colorPerPage: parseFloat(e.target.value) || 0 })} className="w-20 text-xs h-8" />
                                </td>
                                <td className="px-3 py-2">
                                  <Input type="number" min="0" step="0.5" value={editingPaperTypeForm.blackWhitePerPage} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, blackWhitePerPage: parseFloat(e.target.value) || 0 })} className="w-20 text-xs h-8" />
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex gap-1">
                                    <Button size="sm" variant="default" onClick={() => handleSavePaperType(pt.id)} aria-label={isRtl ? "حفظ" : "Save"}><Icon name="check" /></Button>
                                    <Button size="sm" variant="outline" onClick={() => { setEditingPaperTypeId(null); setEditingPaperTypeForm(null); }} aria-label={isRtl ? "إلغاء" : "Cancel"}><Icon name="x" /></Button>
                                  </div>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-3 py-3">
                                  <div className="font-semibold text-foreground text-sm">{isRtl ? pt.nameAr : pt.name}</div>
                                  <div className="text-xs text-muted-foreground">{isRtl ? pt.name : pt.nameAr}</div>
                                </td>
                                <td className="px-3 py-3">
                                  <span className="font-semibold text-indigo-700 dark:text-indigo-400">{pt.colorPerPage}</span>
                                  <span className="text-xs text-muted-foreground ms-1">DZD</span>
                                </td>
                                <td className="px-3 py-3">
                                  <span className="font-semibold text-foreground">{pt.blackWhitePerPage}</span>
                                  <span className="text-xs text-muted-foreground ms-1">DZD</span>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex gap-1">
                                    <Button variant="ghost" size="icon" onClick={() => { setEditingPaperTypeId(pt.id); setEditingPaperTypeForm({ name: pt.name, nameAr: pt.nameAr, colorPerPage: pt.colorPerPage, blackWhitePerPage: pt.blackWhitePerPage }); setShowAddPaperTypeForm(false); }} title="Edit" aria-label="Edit">
                                      <Icon name="edit" className="w-3.5 h-3.5" />
                                    </Button>
                                    {paperTypes.length > 1 && (
                                      <Button variant="ghost" size="icon" onClick={() => handleDeletePaperType(pt.id)} title="Delete" aria-label="Delete">
                                        <Icon name="trash" className="w-3.5 h-3.5" />
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Add Paper Type Dialog */}
                  <Dialog open={showAddPaperTypeForm} onOpenChange={(open) => { if (!open) { setShowAddPaperTypeForm(false); setNewPaperTypeForm({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 }); }}}>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{isRtl ? "إضافة نوع ورق جديد" : "Add New Paper Type"}</DialogTitle>
                      </DialogHeader>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "الاسم (EN)" : "Name (EN)"}</label>
                          <Input
                            value={newPaperTypeForm.name}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, name: e.target.value })}
                            placeholder="e.g. Matte"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "الاسم (AR)" : "Name (AR)"}</label>
                          <Input
                            value={newPaperTypeForm.nameAr}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, nameAr: e.target.value })}
                            placeholder="مثلاً: مطفي"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "سعر ملون (DZD)" : "Color (DZD)"}</label>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            value={newPaperTypeForm.colorPerPage}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, colorPerPage: parseFloat(e.target.value) || 0 })}
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-foreground mb-1.5">{isRtl ? "سعر أبيض/أسود (DZD)" : "B&W (DZD)"}</label>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            value={newPaperTypeForm.blackWhitePerPage}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, blackWhitePerPage: parseFloat(e.target.value) || 0 })}
                          />
                        </div>
                      </div>
                      <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => { setShowAddPaperTypeForm(false); setNewPaperTypeForm({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 }); }}>
                          {isRtl ? "إلغاء" : "Cancel"}
                        </Button>
                        <Button onClick={handleAddPaperType}>
                          {isRtl ? "إضافة" : "Add"}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </CardContent>
              </Card>

              <PasswordCard />

            {/* Discount Rules Card - Full Width */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader className="flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center flex-shrink-0">
                    <Icon name="tag" className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "قواعد الخصم" : "Discount Rules"}</CardTitle>
                    <CardDescription>{isRtl ? "خصومات تلقائية للطباعة بالجملة" : "Automatic bulk print discounts"}</CardDescription>
                  </div>
                </div>
                <Button size="sm" onClick={handleAddRule}>
                  <Icon name="plus" className="w-4 h-4" />
                  {isRtl ? "إضافة قاعدة" : "Add Rule"}
                </Button>
              </CardHeader>

              <CardContent>
                {discountRules.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Icon name="frown" className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-500" />
                    <p>{isRtl ? "لا توجد قواعد خصم بعد" : "No discount rules yet"}</p>
                    <p className="text-sm mt-1">
                      {isRtl ? "انقر على إضافة قاعدة لإنشاء خصم جديد" : "Click Add Rule to create a discount"}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {discountRules.map((rule) => (
                      <div
                        key={rule.id}
                        className={`flex items-center justify-between p-4 rounded-xl border transition-all ${
                          rule.is_active
                            ? "bg-card border-border"
                            : "bg-muted/40 border-border opacity-60"
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          {/* Active Toggle */}
                          <button
                            type="button"
                            onClick={() => handleToggleRuleActive(rule)}
                            className={`relative w-12 h-6 rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-purple-500/40 dark:focus:ring-purple-400/40 ${
                              rule.is_active ? "bg-purple-600 dark:bg-purple-500" : "bg-gray-300 dark:bg-gray-600"
                            }`}
                          >
                            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow-md dark:shadow-gray-800/50 transition-all duration-300 ${
                              isRtl
                                ? (rule.is_active ? "right-[1.625rem]" : "right-0.5")
                                : (rule.is_active ? "left-[1.625rem]" : "left-0.5")
                            }`} />
                          </button>

                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-foreground">{rule.name}</span>
                              {rule.priority > 0 && (
                                <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-xs rounded-full font-medium">
                                  P{rule.priority}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {rule.discount_type === "percent"
                                ? `${rule.discount_value}% ${isRtl ? "خصم" : "off"}`
                                : `${rule.discount_value} DZD ${isRtl ? "خصم" : "off"}`}
                              {" · "}
                              {rule.condition_type === "pages"
                                ? `${isRtl ? "عند" : "when"} ≥ ${rule.threshold} ${isRtl ? "صفحة" : "pages"}`
                                : `${isRtl ? "عند" : "when"} ≥ ${rule.threshold} DZD`}
                              {rule.max_discount_cap && ` ${isRtl ? "(حد أقصى" : "(max"} ${rule.max_discount_cap} DZD)`}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" onClick={() => handleEditRule(rule)} aria-label={isRtl ? "تعديل القاعدة" : "Edit rule"}>
                            <Icon name="edit" className="w-5 h-5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)} aria-label={isRtl ? "حذف القاعدة" : "Delete rule"}>
                            <Icon name="trash" className="w-5 h-5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Cloud Sync Card */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 flex items-center justify-center flex-shrink-0">
                    <Icon name="cloud-upload" className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "المزامنة السحابية" : "Cloud Sync"}</CardTitle>
                    <CardDescription>{isRtl ? "المزامنة مع تطبيق السحابة للطلبات والإعدادات" : "Sync orders and settings with a cloud instance"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">
                    {isRtl ? "رابط المتجر السحابي" : "Store link"}
                  </label>
                  <Input value={cloudSyncUrl} onChange={(e) => { setCloudSyncUrl(e.target.value); setCloudTestResult(null); }} placeholder="https://print.example.com/s/your-store" />
                  <p className="text-xs text-muted-foreground mt-1">
                    {isRtl
                      ? "الصق الرابط كما زوّدك به المشرف؛ يُستخرج معرّف المتجر منه تلقائيًا."
                      : "Paste the link exactly as your platform admin gave it — the store slug is extracted automatically."}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">
                    {isRtl ? "معرّف المتجر (slug)" : "Store slug"}
                  </label>
                  <Input value={cloudShopSlug} onChange={(e) => setCloudShopSlug(e.target.value)} placeholder="your-store" />
                  <p className="text-xs text-muted-foreground mt-1">
                    {isRtl
                      ? "يُملأ تلقائيًا من الرابط أعلاه أو بعد أول مزامنة. يُستخدم لبناء رابط الرفع: /s/<slug>/upload"
                      : "Filled automatically from the link above, or after the first sync. Used to build the upload link: /s/<slug>/upload"}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">
                    {isRtl ? "رمز API" : "API Token"}
                  </label>
                  <Input type="password" value={shopApiToken} onChange={(e) => { setShopApiToken(e.target.value); setCloudTestResult(null); }} placeholder={isRtl ? "64 حرفًا سداسيًا" : "64-char hex token"} />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-foreground mb-2">
                    {isRtl ? "فترة التحديث (مللي ثانية)" : "Poll Interval (ms)"}
                  </label>
                  <Input type="number" min="15000" step="1000" value={cloudSyncPollInterval} onChange={(e) => setCloudSyncPollInterval(e.target.value)} />
                  <p className="text-xs text-muted-foreground mt-1">
                    {isRtl ? "الحد الأدنى 15000 (15 ثانية)" : "Minimum 15000 (15 seconds)"}
                  </p>
                </div>
                <div className="flex items-start justify-between gap-4 pt-2 border-t border-border">
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      {isRtl ? "قبول طلبات السحابة تلقائيًا" : "Auto-accept cloud orders"}
                    </label>
                    <p className="text-xs text-muted-foreground mt-1 max-w-md">
                      {isRtl
                        ? "عند التعطيل، ستظهر الطلبات الواردة من الرابط الإلكتروني في قسم \"مراجعة الطلبات\" لقبولها أو رفضها يدويًا قبل إضافتها إلى قائمة الطباعة."
                        : "When off, orders from the online upload link land in \"Job Review\" for you to accept or reject before they're added to the print queue."}
                    </p>
                  </div>
                  <Switch
                    checked={autoAcceptCloudJobs}
                    onCheckedChange={(checked) => setAutoAcceptCloudJobs(checked)}
                    className="shrink-0"
                  />
                </div>
                <div className="pt-3 border-t border-border space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={cloudTesting !== null}
                      onClick={() => runCloudTest("draft")}
                    >
                      <Icon name="zap" className="w-4 h-4" />
                      {cloudTesting === "draft"
                        ? (isRtl ? "جارٍ الاختبار..." : "Testing…")
                        : (isRtl ? "اختبار هذه القيم" : "Test these values")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      disabled={cloudTesting !== null}
                      onClick={() => runCloudTest("saved")}
                    >
                      <Icon name="refresh" className="w-4 h-4" />
                      {cloudTesting === "saved"
                        ? (isRtl ? "جارٍ الاختبار..." : "Testing…")
                        : (isRtl ? "اختبار الاتصال المحفوظ" : "Test saved connection")}
                    </Button>
                  </div>
                  {cloudTestResult && (
                    <p
                      className={cn(
                        "text-xs",
                        cloudTestResult.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {cloudTestResult.text}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {isRtl
                      ? "الاختبار يقرأ إعدادات المتجر من السحابة فقط؛ لا يغيّر أي بيانات."
                      : "The test only reads this shop's settings from the cloud — it changes nothing."}
                  </p>
                </div>
                {renderSaveBar(cloudDirty, "cloud", saveCloudSync)}
              </CardContent>
            </Card>

            {/* Inventory Card */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
                    <Icon name="package" className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "المخزون" : "Inventory"}</CardTitle>
                    <CardDescription>{isRtl ? "خصم الورق تلقائيًا عند الطباعة" : "Automatic paper deduction on printing"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      {isRtl ? "خصم المخزون تلقائيًا" : "Auto-deduct stock"}
                    </label>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                      {isRtl
                        ? "عند التفعيل، وبمجرد تحديد أي طلب كـ\"تمت الطباعة\"، يتم خصم (عدد الصفحات × عدد النسخ) تلقائيًا من عنصر المخزون المرتبط بنوع الورق المستخدم. إذا لم يكن هناك عنصر مرتبط بذلك النوع، فلن يحدث أي شيء. الحبر والمستلزمات الأخرى تُعدَّل يدويًا دائمًا."
                        : "When on, marking any job as printed subtracts pages × copies from the inventory item linked to that job's paper type. If no item is linked to that paper type, nothing happens. Ink/toner and other supplies are always adjusted manually."}
                    </p>
                    <button
                      type="button"
                      onClick={onManageInventory}
                      className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline mt-2"
                    >
                      <>{isRtl ? "إدارة عناصر المخزون" : "Manage inventory items"}<Icon name="arrow-end" className="ms-1 inline-block align-text-bottom rtl:rotate-180" /></>
                    </button>
                  </div>
                  <Switch
                    checked={autoDeductStock}
                    onCheckedChange={(checked) => setAutoDeductStock(checked)}
                    className="shrink-0"
                  />
                </div>
                {renderSaveBar(inventoryDirty, "inventory", saveInventory)}
              </CardContent>
            </Card>

            <PrintersCard
              currentSettings={currentSettings}
              onPersist={persistSection}
              renderSaveBar={renderSaveBar}
            />

            <BackupCard />
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mt-8">
              <div className="bg-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-muted-foreground mb-1">
                  {isRtl ? "الملفات المعلقة" : "Pending Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                  {jobStats.pending}
                </div>
              </div>
              <div className="bg-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-muted-foreground mb-1">
                  {isRtl ? "جاهز للاستلام" : "Ready Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {jobStats.ready}
                </div>
              </div>
              <div className="bg-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-muted-foreground mb-1">
                  {isRtl ? "الملفات المطبوعة" : "Printed Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-green-600 dark:text-green-400">
                  {jobStats.printed}
                </div>
              </div>
              <div className="bg-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-muted-foreground mb-1">
                  {isRtl ? "إجمالي العملاء" : "Total Customers"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                  {jobStats.customers}
                </div>
              </div>
            </div>
          </div>
      <QrPosterDialog
        open={qrPosterOpen}
        onOpenChange={setQrPosterOpen}
        lang={lang}
        shopSettings={currentSettings}
        allowPrint
      />
      {/* Map location picker. Mounted only while open so Leaflet is never
          loaded for an operator who is editing prices. */}
      <Dialog open={locationOpen} onOpenChange={setLocationOpen}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isRtl ? "موقع المحل" : "Shop location"}</DialogTitle>
          </DialogHeader>
          {locationOpen && (
            <LocationPicker
              value={location}
              onChange={setLocation}
              isRtl={isRtl}
              resolveShortLink={(url: string) => storageService.resolveMapLink(url)}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setLocationOpen(false)}>{isRtl ? "تم" : "Done"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Rule Confirmation */}
      <AlertDialog open={deleteRuleConfirm !== null} onOpenChange={(open) => { if (!open) setDeleteRuleConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "تأكيد حذف القاعدة" : "Delete Rule Confirmation"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl ? "هل أنت متأكد من حذف قاعدة الخصم هذه؟ لا يمكن التراجع عن هذا الإجراء." : "Are you sure you want to delete this discount rule? This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteRule} className="bg-destructive text-destructive-foreground dark:text-destructive-foreground hover:bg-destructive/90 dark:hover:bg-destructive/70">{isRtl ? "حذف" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
{/* Rule Form Dialog */}
<Dialog open={showRuleForm} onOpenChange={setShowRuleForm}>
  <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>
        {isEditingRule
          ? (isRtl ? "تعديل قاعدة الخصم" : "Edit Discount Rule")
          : (isRtl ? "إضافة قاعدة خصم" : "Add Discount Rule")}
      </DialogTitle>
    </DialogHeader>

    <div className="space-y-5">
      {/* Rule Name */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {isRtl ? "اسم القاعدة" : "Rule Name"} *
        </label>
        <Input
          value={ruleFormData.name || ""}
          onChange={(e) => setRuleFormData({ ...ruleFormData, name: e.target.value })}
          placeholder={isRtl ? "مثال: خصم الطلبات الكبيرة" : "e.g., Bulk Order Discount"}
        />
      </div>

      {/* Discount Type */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {isRtl ? "نوع الخصم" : "Discount Type"}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Button
            type="button"
            variant={ruleFormData.discount_type === "percent" ? "default" : "outline"}
            onClick={() => setRuleFormData({ ...ruleFormData, discount_type: "percent" })}
          >
            {isRtl ? "نسبة مئوية (%)" : "Percentage (%)"}
          </Button>
          <Button
            type="button"
            variant={ruleFormData.discount_type === "fixed" ? "default" : "outline"}
            onClick={() => setRuleFormData({ ...ruleFormData, discount_type: "fixed" })}
          >
            {isRtl ? "مبلغ ثابت (DZD)" : "Fixed Amount (DZD)"}
          </Button>
        </div>
      </div>

      {/* Discount Value */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {ruleFormData.discount_type === "percent"
            ? (isRtl ? "نسبة الخصم" : "Discount Percentage")
            : (isRtl ? "مبلغ الخصم" : "Discount Amount")}
        </label>
        <div className="relative">
          <Input
            type="number"
            min="0"
            step={ruleFormData.discount_type === "percent" ? "1" : "0.01"}
            value={ruleFormData.discount_value || ""}
            onChange={(e) => setRuleFormData({ ...ruleFormData, discount_value: parseFloat(e.target.value) })}
            placeholder={ruleFormData.discount_type === "percent" ? (isRtl ? "مثال: 10" : "e.g. 10") : (isRtl ? "مثال: 50" : "e.g. 50")}
            className={"pe-16 ps-4"}
          />
          <span className="absolute end-4 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold pointer-events-none">
            {ruleFormData.discount_type === "percent" ? "%" : "DZD"}
          </span>
        </div>
      </div>

      {/* Condition Type */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {isRtl ? "الشرط" : "Condition"}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Button
            type="button"
            variant={ruleFormData.condition_type === "pages" ? "default" : "outline"}
            onClick={() => setRuleFormData({ ...ruleFormData, condition_type: "pages" })}
          >
            {isRtl ? "عدد الصفحات" : "Page Count"}
          </Button>
          <Button
            type="button"
            variant={ruleFormData.condition_type === "amount" ? "default" : "outline"}
            onClick={() => setRuleFormData({ ...ruleFormData, condition_type: "amount" })}
          >
            {isRtl ? "المبلغ الإجمالي" : "Total Amount"}
          </Button>
        </div>
      </div>

      {/* Threshold */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {ruleFormData.condition_type === "pages"
            ? (isRtl ? "الحد الأدنى للصفحات" : "Minimum Pages")
            : (isRtl ? "الحد الأدنى للمبلغ" : "Minimum Amount")}
        </label>
        <div className="relative">
          <Input
            type="number"
            min="1"
            value={ruleFormData.threshold || ""}
            onChange={(e) => setRuleFormData({ ...ruleFormData, threshold: parseInt(e.target.value) })}
            className={"pe-20 ps-4"}
          />
          <span className="absolute end-4 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold pointer-events-none">
            {ruleFormData.condition_type === "pages"
              ? (isRtl ? "صفحة" : "pages")
              : "DZD"}
          </span>
        </div>
      </div>

      {/* Max Cap (Optional) */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {isRtl ? "الحد الأقصى للخصم (اختياري)" : "Max Discount Cap (Optional)"}
        </label>
        <div className="relative">
          <Input
            type="number"
            min="0"
            step="0.01"
            value={ruleFormData.max_discount_cap || ""}
            onChange={(e) => setRuleFormData({ ...ruleFormData, max_discount_cap: e.target.value ? parseFloat(e.target.value) : null })}
            placeholder={isRtl ? "بدون حد أقصى" : "No cap"}
            className={"pe-16 ps-4"}
          />
          <span className="absolute end-4 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold pointer-events-none">
            DZD
          </span>
        </div>
      </div>

      {/* Priority */}
      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {isRtl ? "الأولوية" : "Priority"}
        </label>
        <Input
          type="number"
          min="0"
          value={ruleFormData.priority || 0}
          onChange={(e) => setRuleFormData({ ...ruleFormData, priority: parseInt(e.target.value) || 0 })}
        />
        <p className="text-xs text-muted-foreground mt-1">
          {isRtl ? "أرقام أعلى = أولوية أعلى" : "Higher numbers = higher priority"}
        </p>
      </div>
    </div>

    <DialogFooter className="gap-2">
      <Button variant="outline" onClick={() => setShowRuleForm(false)}>
        {isRtl ? "إلغاء" : "Cancel"}
      </Button>
      <Button onClick={handleSaveRule}>
        {isEditingRule
          ? (isRtl ? "حفظ التغييرات" : "Save Changes")
          : (isRtl ? "إنشاء القاعدة" : "Create Rule")}
      </Button>
    </DialogFooter>
    </DialogContent>
</Dialog>
    </>
  );
};

export default SettingsPanel;
