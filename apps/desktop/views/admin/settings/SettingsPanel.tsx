import React, { useEffect, useState } from "react";
import { DiscountRule, DiscountType, ConditionType, PaperType, PrinterJobDefaults } from "../../../types";
import { storageService } from "../../../services/storageService";
import { isElectron, getPrinters, PrinterInfo } from "../../../lib/electronPrint";
import { cn } from "@localprint/shared";
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
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import QrPosterDialog from "../../../components/QrPosterDialog";
import { useAdmin } from "../AdminContext";

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

const PAPER_TYPE_FALLBACK = (pricing: any): PaperType[] => [
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
  const [showAddPaperTypeForm, setShowAddPaperTypeForm] = useState(false);
  const [newPaperTypeForm, setNewPaperTypeForm] = useState({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 });
  const [showPasswords, setShowPasswords] = useState({ current: false, newPass: false, confirm: false });
  const [cloudSyncUrl, setCloudSyncUrl] = useState(currentSettings.cloudSyncUrl || "");
  const [cloudShopSlug, setCloudShopSlug] = useState(currentSettings.cloudShopSlug || "");
  const [shopApiToken, setShopApiToken] = useState(currentSettings.shopApiToken || "");
  const [cloudSyncPollInterval, setCloudSyncPollInterval] = useState(currentSettings.cloudSyncPollInterval || "30000");
  const [autoAcceptCloudJobs, setAutoAcceptCloudJobs] = useState(currentSettings.autoAcceptCloudJobs !== false);
  const [autoDeductStock, setAutoDeductStock] = useState(currentSettings.autoDeductStock === true);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [defaultPrinterName, setDefaultPrinterName] = useState<string>(currentSettings.defaultPrinterName || "");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>(currentSettings.printerDefaults || {});
  const [backupRestoreOpen, setBackupRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [qrPosterOpen, setQrPosterOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: "", newPass: "", confirm: "" });
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);
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
    const clean = (local: any, prevVal: any) =>
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
    if (clean(cloudSyncUrl, prev?.cloudSyncUrl ?? "")) setCloudSyncUrl(currentSettings.cloudSyncUrl || "");
    if (clean(cloudShopSlug, prev?.cloudShopSlug ?? "")) setCloudShopSlug(currentSettings.cloudShopSlug || "");
    if (clean(shopApiToken, prev?.shopApiToken ?? "")) setShopApiToken(currentSettings.shopApiToken || "");
    if (clean(cloudSyncPollInterval, prev?.cloudSyncPollInterval || "30000")) setCloudSyncPollInterval(currentSettings.cloudSyncPollInterval || "30000");
    if (clean(autoAcceptCloudJobs, prev ? prev.autoAcceptCloudJobs !== false : undefined)) setAutoAcceptCloudJobs(currentSettings.autoAcceptCloudJobs !== false);
    if (clean(autoDeductStock, prev ? prev.autoDeductStock === true : undefined)) setAutoDeductStock(currentSettings.autoDeductStock === true);
    if (clean(defaultPrinterName, prev?.defaultPrinterName ?? "")) setDefaultPrinterName(currentSettings.defaultPrinterName || "");
    if (clean(printerDefaults, prev?.printerDefaults ?? {})) setPrinterDefaults(currentSettings.printerDefaults || {});

    prevSyncedRef.current = currentSettings;
  }, [currentSettings]);

  const loadPrinters = React.useCallback(async () => {
    if (!isElectron()) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const list = await getPrinters();
      setPrinters(list);
    } catch (err) {
      setPrintersError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrintersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrinters();
  }, [loadPrinters]);

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

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);
    if (passwordForm.newPass !== passwordForm.confirm) {
      setPasswordError(isRtl ? "كلمات المرور الجديدة غير متطابقة" : "New passwords do not match");
      return;
    }
    if (passwordForm.newPass.length < 4) {
      setPasswordError(isRtl ? "يجب أن تكون كلمة المرور 4 أحرف على الأقل" : "Password must be at least 4 characters");
      return;
    }
    try {
      await storageService.changePassword(passwordForm.current, passwordForm.newPass);
      setPasswordSuccess(true);
      setPasswordForm({ current: "", newPass: "", confirm: "" });
      toast({ title: isRtl ? "تم تغيير كلمة المرور بنجاح" : "Password changed successfully", variant: "success" });
    } catch {
      setPasswordError(isRtl ? "كلمة المرور الحالية غير صحيحة" : "Current password is incorrect");
    }
  };

  const handleBackupDownload = () => {
    storageService.downloadBackup();
  };

  const handleBackupRestore = async () => {
    if (!restoreFile) return;
    setRestoring(true);
    try {
      await storageService.restoreBackup(restoreFile);
      toast({ title: isRtl ? "تمت الاستعادة. إعادة تحميل..." : "Restored. Reloading...", variant: "success" });
      setBackupRestoreOpen(false);
      setRestoreFile(null);
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      toast({ title: isRtl ? "فشل الاستعادة" : "Restore failed", description: err.message, variant: "destructive" });
    } finally {
      setRestoring(false);
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
    } catch (err: any) {
      toast({ title: isRtl ? "فشل إضافة نوع الورق" : "Failed to add paper type", description: err?.message, variant: "destructive" });
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
    } catch (err: any) {
      toast({ title: isRtl ? "فشل حفظ نوع الورق" : "Failed to save paper type", description: err?.message, variant: "destructive" });
    }
  };

  const handleDeletePaperType = async (id: string) => {
    try {
      await storageService.deletePaperType(id);
      syncPaperTypes(paperTypes.filter((pt) => pt.id !== id));
      toast({ title: isRtl ? "تم حذف نوع الورق" : "Paper type deleted", variant: "success" });
    } catch (err: any) {
      toast({ title: isRtl ? "فشل حذف نوع الورق" : "Failed to delete paper type", description: err?.message, variant: "destructive" });
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
    } catch (err: any) {
      toast({ title: isRtl ? "فشل الحفظ" : "Save failed", description: err?.message, variant: "destructive" });
    } finally {
      setSavingSection(null);
    }
  };

  const saveShopInfo = () =>
    persistSection("shop", { shopName, currency, phoneNumbers, email, address, workingHours, returnPolicy });
  const saveCloudSync = () =>
    persistSection("cloud", { cloudSyncUrl, cloudShopSlug, shopApiToken, cloudSyncPollInterval, autoAcceptCloudJobs });
  const saveInventory = () => persistSection("inventory", { autoDeductStock });
  const savePrinters = () => persistSection("printers", { defaultPrinterName, printerDefaults });

  // Per-section dirty flags — drive each Save button's enabled state so one
  // section's Save never silently ships another section's half-made edits.
  const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  const shopDirty =
    shopName !== currentSettings.shopName ||
    currency !== (currentSettings.currency || "") ||
    !eq(phoneNumbers, currentSettings.phoneNumbers || []) ||
    email !== (currentSettings.email || "") ||
    address !== (currentSettings.address || "") ||
    workingHours !== (currentSettings.workingHours || "") ||
    returnPolicy !== (currentSettings.returnPolicy || "");
  const cloudDirty =
    cloudSyncUrl !== (currentSettings.cloudSyncUrl || "") ||
    cloudShopSlug !== (currentSettings.cloudShopSlug || "") ||
    shopApiToken !== (currentSettings.shopApiToken || "") ||
    cloudSyncPollInterval !== (currentSettings.cloudSyncPollInterval || "30000") ||
    autoAcceptCloudJobs !== (currentSettings.autoAcceptCloudJobs !== false);
  const inventoryDirty = autoDeductStock !== (currentSettings.autoDeductStock === true);
  const printersDirty =
    defaultPrinterName !== (currentSettings.defaultPrinterName || "") ||
    !eq(printerDefaults, currentSettings.printerDefaults || {});

  const renderSaveBar = (dirty: boolean, section: string, onSave: () => void) => (
    <div className="flex items-center justify-end gap-3 pt-3 mt-1 border-t border-gray-100 dark:border-gray-800">
      {dirty && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {isRtl ? "تغييرات غير محفوظة" : "Unsaved changes"}
        </span>
      )}
      <Button onClick={onSave} disabled={!dirty || savingSection === section} size="sm" className="gap-1.5">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
        </svg>
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
      } catch (err) {
        toast({ title: isRtl ? "فشل رفع الشعار" : "Failed to upload logo", variant: "destructive" });
      }
    }
  };

  return (
    <>
          <div className="max-w-5xl mx-auto">
            {/* Page Header */}
            <div className="mb-8">
              <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
                {isRtl ? "إعدادات المحل" : "Shop Settings"}
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mt-1 text-sm sm:text-base">
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
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" />
                      </svg>
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
                    <p className="text-xs text-gray-500 dark:text-gray-400 max-w-md">
                      {isRtl
                        ? "يمكنك اختيار رابط الشبكة المحلية أو رابط الموقع الإلكتروني قبل الطباعة."
                        : "Pick the local-network link or the online website link before printing."}
                    </p>
                    <Button onClick={() => setQrPosterOpen(true)} className="gap-2 w-full sm:w-auto">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9V4h12v5M6 18h12v-6H6zM6 14H4a2 2 0 01-2-2V9a2 2 0 012-2h16a2 2 0 012 2v3a2 2 0 01-2 2h-2" />
                      </svg>
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
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? "معلومات المحل" : "Shop Information"}</CardTitle>
                      <CardDescription>{isRtl ? "الاسم والشعار" : "Name & logo"}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopName")}</label>
                    <Input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder={isRtl ? "اسم المحل" : "Print Shop Name"} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopLogo")}</label>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      {logoUrl ? (
                        <div className="w-20 h-20 rounded-xl border-2 border-white dark:border-gray-700 shadow-md dark:shadow-gray-800/50 overflow-hidden bg-gray-100 dark:bg-gray-800 flex-shrink-0">
                          <img src={logoUrl} alt="Logo Preview" className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 flex items-center justify-center flex-shrink-0">
                          <svg className="w-8 h-8 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 w-full">
                        <Input type="file" accept="image/*" onChange={handleLogoUpload} className="file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 dark:file:bg-indigo-900/30 file:text-indigo-600 dark:file:text-indigo-400 file:hover:bg-indigo-100 dark:file:hover:bg-indigo-900/50 file:cursor-pointer cursor-pointer" />
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{isRtl ? "PNG, JPG أو GIF (الحد الأقصى 2MB)" : "PNG, JPG or GIF (max 2MB)"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Phone Numbers */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopPhone")}</label>
                    <div className="space-y-2">
                      {phoneNumbers.map((num, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Input value={num} onChange={(e) => { const next = [...phoneNumbers]; next[idx] = e.target.value; setPhoneNumbers(next); }} placeholder={isRtl ? "رقم الهاتف" : "Phone number"} />
                          <button type="button" onClick={() => setPhoneNumbers(phoneNumbers.filter((_, i) => i !== idx))} className="p-2 text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                      <Button variant="outline" size="sm" onClick={() => setPhoneNumbers([...phoneNumbers, ""])}>
                        <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"/></svg>
                        {t("addPhone")}
                      </Button>
                    </div>
                  </div>

                  {/* Email */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopEmail")}</label>
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={isRtl ? "البريد الإلكتروني" : "shop@example.com"} />
                  </div>

                  {/* Address */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopAddress")}</label>
                    <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={isRtl ? "عنوان المحل" : "123 Main St, City"} />
                  </div>

                  {/* Working Hours */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopWorkingHours")}</label>
                    <Input value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} placeholder={isRtl ? "ساعات العمل" : "Sat-Thu 9:00-18:00"} />
                  </div>

                  {/* Return Policy */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("shopReturnPolicy")}</label>
                    <textarea value={returnPolicy} onChange={(e) => setReturnPolicy(e.target.value)} rows={3} className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 resize-y" placeholder={isRtl ? "سياسة الإرجاع" : "Return policy details..."} />
                  </div>

                  {/* Currency */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{isRtl ? "العملة" : "Currency"}</label>
                    <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder={isRtl ? "مثال: DZD" : "e.g. DZD"} />
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{isRtl ? "تظهر بجانب الأسعار في جميع أنحاء التطبيق." : "Shown next to prices across the app."}</p>
                  </div>

                  {renderSaveBar(shopDirty, "shop", saveShopInfo)}
                </CardContent>
              </Card>

              {/* Pricing Card */}
              <Card className="border-0">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? "أسعار الطباعة" : "Printing Prices"}</CardTitle>
                      <CardDescription>{isRtl ? "التسعير لكل صفحة" : "Per page pricing"}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {isRtl ? "أنواع الورق وأسعارها" : "Paper Types & Pricing"}
                    </label>
                    <Button size="sm" onClick={() => { setShowAddPaperTypeForm(true); setEditingPaperTypeId(null); }}>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"/></svg>
                      {isRtl ? "إضافة نوع" : "Add Type"}
                    </Button>
                  </div>

                  <div className="overflow-x-auto rounded-xl">
                    <table className="w-full text-sm min-w-[400px]">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 ${isRtl ? "text-right" : "text-left"}`}>{isRtl ? "نوع الورق" : "Paper Type"}</th>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 ${isRtl ? "text-right" : "text-left"}`}>{isRtl ? "ملون" : "Color"}</th>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 ${isRtl ? "text-right" : "text-left"}`}>{isRtl ? "أبيض/أسود" : "B&W"}</th>
                          <th className="px-3 py-2.5 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {paperTypes.map((pt, idx) => (
                          <tr key={pt.id} className={idx < paperTypes.length - 1 ? "border-b border-gray-100 dark:border-gray-800" : ""}>
                            {editingPaperTypeId === pt.id && editingPaperTypeForm ? (
                              <>
                                <td className="px-3 py-2">
                                  <Input value={editingPaperTypeForm.name} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, name: e.target.value })} placeholder="EN" className="text-xs mb-1 h-7" />
                                  <Input value={editingPaperTypeForm.nameAr} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, nameAr: e.target.value })} placeholder="AR" className="text-xs h-7" />
                                </td>
                                <td className="px-3 py-2">
                                  <Input type="number" min="0" step="0.5" value={editingPaperTypeForm.colorPerPage} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, colorPerPage: parseFloat(e.target.value) || 0 })} className="w-20 text-xs h-7" />
                                </td>
                                <td className="px-3 py-2">
                                  <Input type="number" min="0" step="0.5" value={editingPaperTypeForm.blackWhitePerPage} onChange={e => setEditingPaperTypeForm({ ...editingPaperTypeForm, blackWhitePerPage: parseFloat(e.target.value) || 0 })} className="w-20 text-xs h-7" />
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex gap-1">
                                    <Button size="sm" variant="default" onClick={() => handleSavePaperType(pt.id)}>✓</Button>
                                    <Button size="sm" variant="outline" onClick={() => { setEditingPaperTypeId(null); setEditingPaperTypeForm(null); }}>✕</Button>
                                  </div>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-3 py-3">
                                  <div className="font-semibold text-gray-900 dark:text-gray-100 text-sm">{isRtl ? pt.nameAr : pt.name}</div>
                                  <div className="text-xs text-gray-400 dark:text-gray-500">{isRtl ? pt.name : pt.nameAr}</div>
                                </td>
                                <td className="px-3 py-3">
                                  <span className="font-semibold text-indigo-700 dark:text-indigo-400">{pt.colorPerPage}</span>
                                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">DZD</span>
                                </td>
                                <td className="px-3 py-3">
                                  <span className="font-semibold text-gray-700 dark:text-gray-200">{pt.blackWhitePerPage}</span>
                                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">DZD</span>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex gap-1">
                                    <Button variant="ghost" size="icon" onClick={() => { setEditingPaperTypeId(pt.id); setEditingPaperTypeForm({ name: pt.name, nameAr: pt.nameAr, colorPerPage: pt.colorPerPage, blackWhitePerPage: pt.blackWhitePerPage }); setShowAddPaperTypeForm(false); }} title="Edit">
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536M9 11l6.071-6.071a2.5 2.5 0 113.536 3.536L12.536 14.5a2 2 0 01-.93.534l-3.192.798.798-3.192a2 2 0 01.534-.93L9 11z"/></svg>
                                    </Button>
                                    {paperTypes.length > 1 && (
                                      <Button variant="ghost" size="icon" onClick={() => handleDeletePaperType(pt.id)} title="Delete">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
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
                          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1.5">{isRtl ? "الاسم (EN)" : "Name (EN)"}</label>
                          <Input
                            value={newPaperTypeForm.name}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, name: e.target.value })}
                            placeholder="e.g. Matte"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1.5">{isRtl ? "الاسم (AR)" : "Name (AR)"}</label>
                          <Input
                            value={newPaperTypeForm.nameAr}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, nameAr: e.target.value })}
                            placeholder="مثلاً: مطفي"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1.5">{isRtl ? "سعر ملون (DZD)" : "Color (DZD)"}</label>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            value={newPaperTypeForm.colorPerPage}
                            onChange={e => setNewPaperTypeForm({ ...newPaperTypeForm, colorPerPage: parseFloat(e.target.value) || 0 })}
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1.5">{isRtl ? "سعر أبيض/أسود (DZD)" : "B&W (DZD)"}</label>
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

              {/* Password Change Card — full width */}
              <Card className="lg:col-span-2 border-0">
              <CardHeader className="flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "تغيير كلمة المرور" : "Change Password"}</CardTitle>
                    <CardDescription>{isRtl ? "تحديث كلمة مرور المسؤول" : "Update admin password"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <form onSubmit={handleChangePassword} className="p-5 sm:p-6 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{isRtl ? "كلمة المرور الحالية" : "Current Password"}</label>
                    <div className="relative">
                      <Input type={showPasswords.current ? "text" : "password"} value={passwordForm.current} onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })} placeholder="••••••••" required className="pr-10" />
                      <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, current: !p.current }))} className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" tabIndex={-1}>
                        {showPasswords.current ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg> : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{isRtl ? "كلمة المرور الجديدة" : "New Password"}</label>
                    <div className="relative">
                      <Input type={showPasswords.newPass ? "text" : "password"} value={passwordForm.newPass} onChange={(e) => setPasswordForm({ ...passwordForm, newPass: e.target.value })} placeholder="••••••••" required className="pr-10" />
                      <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, newPass: !p.newPass }))} className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" tabIndex={-1}>
                        {showPasswords.newPass ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg> : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{isRtl ? "تأكيد كلمة المرور" : "Confirm Password"}</label>
                    <div className="relative">
                      <Input type={showPasswords.confirm ? "text" : "password"} value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} placeholder="••••••••" required className="pr-10" />
                      <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, confirm: !p.confirm }))} className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" tabIndex={-1}>
                        {showPasswords.confirm ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg> : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>}
                      </Button>
                    </div>
                  </div>
                </div>
                {passwordError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{passwordError}</p>}
                {passwordSuccess && <p className="text-sm text-green-600 dark:text-green-400 font-medium">{isRtl ? "✓ تم تغيير كلمة المرور بنجاح" : "✓ Password changed successfully"}</p>}
                <Button type="submit" variant="destructive">{isRtl ? "تغيير كلمة المرور" : "Change Password"}</Button>
              </form>
            </Card>

            {/* Discount Rules Card - Full Width */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader className="flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "قواعد الخصم" : "Discount Rules"}</CardTitle>
                    <CardDescription>{isRtl ? "خصومات تلقائية للطباعة بالجملة" : "Automatic bulk print discounts"}</CardDescription>
                  </div>
                </div>
                <Button size="sm" onClick={handleAddRule}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  {isRtl ? "إضافة قاعدة" : "Add Rule"}
                </Button>
              </CardHeader>

              <CardContent>
                {discountRules.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    <svg className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
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
                            ? "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                            : "bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-800 opacity-60"
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
                            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white dark:bg-gray-800 shadow-md dark:shadow-gray-800/50 transition-all duration-300 ${
                              isRtl
                                ? (rule.is_active ? "right-[1.625rem]" : "right-0.5")
                                : (rule.is_active ? "left-[1.625rem]" : "left-0.5")
                            }`} />
                          </button>

                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-gray-900 dark:text-gray-100">{rule.name}</span>
                              {rule.priority > 0 && (
                                <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-xs rounded-full font-medium">
                                  P{rule.priority}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
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
                          <Button variant="ghost" size="icon" onClick={() => handleEditRule(rule)}>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)}>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
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
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "المزامنة السحابية" : "Cloud Sync"}</CardTitle>
                    <CardDescription>{isRtl ? "المزامنة مع تطبيق السحابة للطلبات والإعدادات" : "Sync orders and settings with a cloud instance"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                    {isRtl ? "رابط المتجر السحابي" : "Store link"}
                  </label>
                  <Input value={cloudSyncUrl} onChange={(e) => setCloudSyncUrl(e.target.value)} placeholder="https://print.example.com/s/your-store" />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {isRtl
                      ? "الصق الرابط كما زوّدك به المشرف؛ يُستخرج معرّف المتجر منه تلقائيًا."
                      : "Paste the link exactly as your platform admin gave it — the store slug is extracted automatically."}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                    {isRtl ? "معرّف المتجر (slug)" : "Store slug"}
                  </label>
                  <Input value={cloudShopSlug} onChange={(e) => setCloudShopSlug(e.target.value)} placeholder="your-store" />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {isRtl
                      ? "يُملأ تلقائيًا من الرابط أعلاه أو بعد أول مزامنة. يُستخدم لبناء رابط الرفع: /s/<slug>/upload"
                      : "Filled automatically from the link above, or after the first sync. Used to build the upload link: /s/<slug>/upload"}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                    {isRtl ? "رمز API" : "API Token"}
                  </label>
                  <Input type="password" value={shopApiToken} onChange={(e) => setShopApiToken(e.target.value)} placeholder={isRtl ? "64 حرفًا سداسيًا" : "64-char hex token"} />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                    {isRtl ? "فترة التحديث (مللي ثانية)" : "Poll Interval (ms)"}
                  </label>
                  <Input type="number" min="15000" step="1000" value={cloudSyncPollInterval} onChange={(e) => setCloudSyncPollInterval(e.target.value)} />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {isRtl ? "الحد الأدنى 15000 (15 ثانية)" : "Minimum 15000 (15 seconds)"}
                  </p>
                </div>
                <div className="flex items-start justify-between gap-4 pt-2 border-t border-gray-100 dark:border-gray-800">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {isRtl ? "قبول طلبات السحابة تلقائيًا" : "Auto-accept cloud orders"}
                    </label>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-md">
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
                {renderSaveBar(cloudDirty, "cloud", saveCloudSync)}
              </CardContent>
            </Card>

            {/* Inventory Card */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
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
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {isRtl ? "خصم المخزون تلقائيًا" : "Auto-deduct stock"}
                    </label>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-xl">
                      {isRtl
                        ? "عند التفعيل، وبمجرد تحديد أي طلب كـ\"تمت الطباعة\"، يتم خصم (عدد الصفحات × عدد النسخ) تلقائيًا من عنصر المخزون المرتبط بنوع الورق المستخدم. إذا لم يكن هناك عنصر مرتبط بذلك النوع، فلن يحدث أي شيء. الحبر والمستلزمات الأخرى تُعدَّل يدويًا دائمًا."
                        : "When on, marking any job as printed subtracts pages × copies from the inventory item linked to that job's paper type. If no item is linked to that paper type, nothing happens. Ink/toner and other supplies are always adjusted manually."}
                    </p>
                    <button
                      type="button"
                      onClick={onManageInventory}
                      className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline mt-2"
                    >
                      {isRtl ? "إدارة عناصر المخزون ←" : "Manage inventory items →"}
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

            {/* Printers Card (Electron-only surface) */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{isRtl ? "الطابعات" : "Printers"}</CardTitle>
                    <CardDescription>{isRtl ? "اختر الطابعة الافتراضية واضبط إعدادات المهمة لكل طابعة" : "Choose a default printer and set per-printer job defaults"}</CardDescription>
                  </div>
                  <div className="ms-auto">
                    <Button variant="outline" size="sm" onClick={loadPrinters} disabled={printersLoading} className="gap-2">
                      <svg className={cn("w-4 h-4", printersLoading && "animate-spin")} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {isRtl ? "تحديث" : "Refresh"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {!isElectron() ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {isRtl
                      ? "الطباعة الأصلية متاحة فقط داخل تطبيق سطح المكتب."
                      : "Native printing is only available inside the desktop app."}
                  </p>
                ) : printersError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{printersError}</p>
                ) : printers.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {printersLoading
                      ? (isRtl ? "جارٍ اكتشاف الطابعات..." : "Detecting printers…")
                      : (isRtl ? "لم يتم العثور على طابعات مثبتة." : "No installed printers were found.")}
                  </p>
                ) : (
                  <div className="space-y-4">
                    {printers.map((p) => {
                      const isDefault = defaultPrinterName === p.name;
                      const d: PrinterJobDefaults = printerDefaults[p.name] || {
                        duplexMode: "simplex",
                        color: true,
                        copies: 1,
                        collate: true,
                        landscape: false,
                      };
                      const patchDefaults = (patch: Partial<PrinterJobDefaults>) => {
                        setPrinterDefaults((prev) => ({ ...prev, [p.name]: { ...d, ...patch } }));
                      };
                      return (
                        <div
                          key={p.name}
                          className={cn(
                            "rounded-xl border p-4",
                            isDefault
                              ? "border-indigo-400 dark:border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20"
                              : "border-gray-200 dark:border-gray-700",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-gray-900 dark:text-gray-100">
                                  {p.displayName || p.name}
                                </span>
                                {p.isDefault && (
                                  <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                    {isRtl ? "افتراضي النظام" : "System default"}
                                  </span>
                                )}
                                {isDefault && (
                                  <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300">
                                    {isRtl ? "الطباعة السريعة" : "Quick Print"}
                                  </span>
                                )}
                              </div>
                              {p.description && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{p.description}</p>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant={isDefault ? "secondary" : "outline"}
                              onClick={() => setDefaultPrinterName(isDefault ? "" : p.name)}
                            >
                              {isDefault
                                ? (isRtl ? "الطابعة الافتراضية" : "Default printer")
                                : (isRtl ? "تعيين كافتراضية" : "Set as default")}
                            </Button>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                            <div>
                              <Label className="text-xs">{isRtl ? "الوجهين" : "Duplex"}</Label>
                              <Select
                                value={d.duplexMode}
                                onValueChange={(v) => patchDefaults({ duplexMode: v as PrinterJobDefaults["duplexMode"] })}
                              >
                                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="simplex">{isRtl ? "وجه واحد" : "Single-sided"}</SelectItem>
                                  <SelectItem value="longEdge">{isRtl ? "وجهين (الحافة الطويلة)" : "Two-sided (long edge)"}</SelectItem>
                                  <SelectItem value="shortEdge">{isRtl ? "وجهين (الحافة القصيرة)" : "Two-sided (short edge)"}</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <Label className="text-xs">{isRtl ? "نسخ" : "Copies"}</Label>
                              <Input
                                type="number"
                                min={1}
                                className="mt-1"
                                value={d.copies}
                                onChange={(e) => patchDefaults({ copies: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                              />
                            </div>
                            <div className="flex flex-col justify-between gap-2">
                              <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                                <Label className="text-xs cursor-pointer">{isRtl ? "ألوان" : "Color"}</Label>
                                <Switch checked={d.color} onCheckedChange={(c) => patchDefaults({ color: c })} />
                              </div>
                              <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                                <Label className="text-xs cursor-pointer">{isRtl ? "ترتيب" : "Collate"}</Label>
                                <Switch checked={d.collate} onCheckedChange={(c) => patchDefaults({ collate: c })} />
                              </div>
                              <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                                <Label className="text-xs cursor-pointer">{isRtl ? "أفقي" : "Landscape"}</Label>
                                <Switch checked={d.landscape} onCheckedChange={(c) => patchDefaults({ landscape: c })} />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {isRtl
                        ? "تُستخدم هذه الإعدادات كنقطة بداية للطباعة السريعة ولمربع حوار خيارات الطباعة."
                        : "These defaults are the starting point for Quick Print and pre-fill the Options print dialog."}
                    </p>
                  </div>
                )}
                {isElectron() && renderSaveBar(printersDirty, "printers", savePrinters)}
              </CardContent>
            </Card>

            {/* Backup & Restore Card */}
            <Card className="lg:col-span-2 border-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 dark:text-gray-500 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-base">{t("backup")}</CardTitle>
                    <CardDescription>{isRtl ? "تنزيل أو استعادة نسخة احتياطية من قاعدة البيانات" : "Download or restore database backup"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <Button variant="outline" onClick={handleBackupDownload} className="gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    {t("downloadBackup")}
                  </Button>
                  <Button variant="outline" onClick={() => setBackupRestoreOpen(true)} className="gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    {t("restoreBackup")}
                  </Button>
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                  {t("restoreWarning")}
                </p>
              </CardContent>
            </Card>

            {/* Backup Restore Dialog */}
            <Dialog open={backupRestoreOpen} onOpenChange={(open) => { if (!open) { setBackupRestoreOpen(false); setRestoreFile(null); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("restoreBackup")}</DialogTitle>
                  <DialogDescription>{t("restoreWarning")}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Input type="file" accept=".sqlite,.db" onChange={(e) => setRestoreFile(e.target.files?.[0] || null)} />
                  {restoreFile && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{restoreFile.name}</p>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => { setBackupRestoreOpen(false); setRestoreFile(null); }}>
                    {t("cancel")}
                  </Button>
                  <Button disabled={!restoreFile || restoring} onClick={handleBackupRestore} variant="destructive">
                    {restoring ? (isRtl ? "جارٍ الاستعادة..." : "Restoring...") : (isRtl ? "استعادة" : "Restore")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mt-8">
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "الملفات المعلقة" : "Pending Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                  {jobStats.pending}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "جاهز للاستلام" : "Ready Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {jobStats.ready}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "الملفات المطبوعة" : "Printed Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-green-600 dark:text-green-400">
                  {jobStats.printed}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
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
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
            className={isRtl ? "pl-16 pr-4" : "pr-16 pl-4"}
          />
          <span className={`absolute ${isRtl ? "left-4" : "right-4"} top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 font-semibold pointer-events-none`}>
            {ruleFormData.discount_type === "percent" ? "%" : "DZD"}
          </span>
        </div>
      </div>

      {/* Condition Type */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
            className={isRtl ? "pl-20 pr-4" : "pr-20 pl-4"}
          />
          <span className={`absolute ${isRtl ? "left-4" : "right-4"} top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 font-semibold pointer-events-none`}>
            {ruleFormData.condition_type === "pages"
              ? (isRtl ? "صفحة" : "pages")
              : "DZD"}
          </span>
        </div>
      </div>

      {/* Max Cap (Optional) */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
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
            className={isRtl ? "pl-16 pr-4" : "pr-16 pl-4"}
          />
          <span className={`absolute ${isRtl ? "left-4" : "right-4"} top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 font-semibold pointer-events-none`}>
            DZD
          </span>
        </div>
      </div>

      {/* Priority */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
          {isRtl ? "الأولوية" : "Priority"}
        </label>
        <Input
          type="number"
          min="0"
          value={ruleFormData.priority || 0}
          onChange={(e) => setRuleFormData({ ...ruleFormData, priority: parseInt(e.target.value) || 0 })}
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
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
