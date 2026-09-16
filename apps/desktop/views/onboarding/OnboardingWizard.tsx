import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Language, ShopSettings, PaperType } from "../../types";
import { storageService } from "../../services/storageService";
import { isElectron, getPrinters, PrinterInfo } from "../../lib/electronPrint";
import { toast } from "../../components/ui/use-toast";
import { Toaster } from "../../components/ui/toaster";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { writePref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";

const DEFAULT_PASSWORD = "admin123";

interface OnboardingWizardProps {
  lang: Language;
  currentSettings: ShopSettings;
  onSettingsUpdate: (settings: ShopSettings) => void;
}

type StepId = "password" | "shop" | "pricing" | "printer" | "cloud" | "gmail";

interface StepMeta {
  id: StepId;
  title: string;
  subtitle: string;
  /** Optional steps can be left untouched; required ones are strongly nudged. */
  optional: boolean;
}

const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ lang, currentSettings, onSettingsUpdate }) => {
  const navigate = useNavigate();
  const isRtl = lang === "ar";
  const tr = (ar: string, en: string) => (isRtl ? ar : en);

  // The printer step only exists in the desktop (Electron) build.
  const steps = useMemo<StepMeta[]>(() => {
    const all: StepMeta[] = [
      { id: "password", title: tr("تعيين كلمة المرور", "Set a password"), subtitle: tr("ابدأ بتأمين لوحة التحكم.", "Start by securing the dashboard."), optional: false },
      { id: "shop", title: tr("هوية المتجر", "Shop identity"), subtitle: tr("الاسم والشعار والعملة.", "Name, logo and currency."), optional: false },
      { id: "pricing", title: tr("التسعير وأنواع الورق", "Pricing & paper types"), subtitle: tr("حدد أسعار الصفحة الأساسية.", "Set your base page prices."), optional: false },
      { id: "printer", title: tr("الطابعة الافتراضية", "Default printer"), subtitle: tr("تُستخدم للطباعة السريعة.", "Used for Quick Print."), optional: true },
      { id: "cloud", title: tr("المزامنة السحابية", "Cloud sync"), subtitle: tr("اختياري — لاستقبال الطلبات عبر الإنترنت.", "Optional — receive online orders."), optional: true },
      { id: "gmail", title: tr("ربط Gmail", "Connect Gmail"), subtitle: tr("اختياري — لاستقبال المرفقات.", "Optional — pull emailed attachments."), optional: true },
    ];
    return all.filter((s) => (s.id === "printer" ? isElectron() : true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  // ── Step 1: password ──
  const [pwCurrent, setPwCurrent] = useState(DEFAULT_PASSWORD);
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState("");

  // ── Step 2: shop identity ──
  const [shopName, setShopName] = useState(currentSettings.shopName || "");
  const [currency, setCurrency] = useState(currentSettings.currency || "DZD");
  const [logoUrl, setLogoUrl] = useState<string | null>(currentSettings.logoUrl || null);
  const [logoUploading, setLogoUploading] = useState(false);

  // ── Step 3: pricing + paper types ──
  const [colorPerPage, setColorPerPage] = useState<number>(currentSettings.pricing?.colorPerPage ?? 30);
  const [bwPerPage, setBwPerPage] = useState<number>(currentSettings.pricing?.blackWhitePerPage ?? 15);
  const [seedPaperTypes, setSeedPaperTypes] = useState<PaperType[]>(() =>
    (currentSettings.paperTypes && currentSettings.paperTypes.length > 0
      ? currentSettings.paperTypes
      : [
          { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: 30, blackWhitePerPage: 15 },
          { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: 50, blackWhitePerPage: 50 },
        ]).map((pt) => ({ ...pt })),
  );

  // ── Step 4: default printer ──
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [defaultPrinterName, setDefaultPrinterName] = useState(currentSettings.defaultPrinterName || "");

  // ── Step 5: cloud sync ──
  const [cloudSyncUrl, setCloudSyncUrl] = useState(currentSettings.cloudSyncUrl || "");
  const [shopApiToken, setShopApiToken] = useState(currentSettings.shopApiToken || "");

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isElectron()) return;
    getPrinters()
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, []);

  const finish = () => {
    try {
      writePref("onboardingDone", "1");
    } catch {
      /* ignore quota / privacy-mode errors — completion is best-effort */
    }
    navigate("/admin/dashboard", { replace: true });
  };

  const goNext = () => {
    if (isLast) finish();
    else setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  };
  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));

  // ── Per-step save handlers. Each returns true on success so the wizard can
  //    advance; a thrown/failed save keeps the user on the step. ──
  const validatePassword = (): boolean => {
    setPwError("");
    if (pwNew.length < 8) {
      setPwError(tr("يجب أن تكون كلمة المرور 8 أحرف على الأقل.", "Password must be at least 8 characters."));
      return false;
    }
    if (/^\d+$/.test(pwNew)) {
      setPwError(tr("لا يمكن أن تتكون كلمة المرور من أرقام فقط.", "Password cannot be all digits."));
      return false;
    }
    if (pwNew === DEFAULT_PASSWORD) {
      setPwError(tr("اختر كلمة مرور مختلفة عن الافتراضية.", "Choose a password different from the default."));
      return false;
    }
    if (pwNew !== pwConfirm) {
      setPwError(tr("كلمتا المرور غير متطابقتين.", "Passwords do not match."));
      return false;
    }
    return true;
  };

  const saveCurrentStep = async (): Promise<boolean> => {
    setSaving(true);
    try {
      switch (step.id) {
        case "password": {
          if (!validatePassword()) return false;
          try {
            await storageService.changePassword(pwCurrent, pwNew);
          } catch {
            setPwError(tr("كلمة المرور الحالية غير صحيحة.", "Current password is incorrect."));
            return false;
          }
          toast({ title: tr("تم تعيين كلمة المرور.", "Password set."), variant: "success" });
          return true;
        }
        case "shop": {
          await storageService.saveSettings({ shopName: shopName.trim(), currency: currency.trim() });
          onSettingsUpdate({ ...currentSettings, shopName: shopName.trim(), currency: currency.trim(), logoUrl });
          toast({ title: tr("تم حفظ هوية المتجر.", "Shop identity saved."), variant: "success" });
          return true;
        }
        case "pricing": {
          await storageService.saveSettings({ pricing: { colorPerPage: Number(colorPerPage) || 0, blackWhitePerPage: Number(bwPerPage) || 0 } });
          // Seed paper types through the granular endpoint (no bulk wipe).
          for (const pt of seedPaperTypes) {
            if (!pt.name.trim()) continue;
            try {
              await storageService.createPaperType({
                id: pt.id || `pt_${pt.name.trim().toLowerCase().replace(/\s+/g, "_")}`,
                name: pt.name.trim(),
                nameAr: pt.nameAr.trim() || pt.name.trim(),
                colorPerPage: Number(pt.colorPerPage) || 0,
                blackWhitePerPage: Number(pt.blackWhitePerPage) || 0,
              });
            } catch {
              /* a duplicate id (already seeded) is fine — keep going */
            }
          }
          toast({ title: tr("تم حفظ التسعير.", "Pricing saved."), variant: "success" });
          return true;
        }
        case "printer": {
          await storageService.saveSettings({ defaultPrinterName });
          onSettingsUpdate({ ...currentSettings, defaultPrinterName });
          toast({ title: tr("تم تعيين الطابعة الافتراضية.", "Default printer set."), variant: "success" });
          return true;
        }
        case "cloud": {
          await storageService.saveSettings({ cloudSyncUrl: cloudSyncUrl.trim(), shopApiToken: shopApiToken.trim() });
          toast({ title: tr("تم حفظ إعدادات المزامنة.", "Cloud sync saved."), variant: "success" });
          return true;
        }
        case "gmail":
          return true;
        default:
          return true;
      }
    } catch (err) {
      toast({ title: tr("فشل الحفظ", "Save failed"), description: errorMessage(err), variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndNext = async () => {
    const ok = await saveCurrentStep();
    if (ok) goNext();
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    try {
      const url = await storageService.uploadLogo(file);
      setLogoUrl(url);
      onSettingsUpdate({ ...currentSettings, logoUrl: url });
      toast({ title: tr("تم رفع الشعار.", "Logo uploaded."), variant: "success" });
    } catch (err) {
      toast({ title: tr("فشل رفع الشعار", "Logo upload failed"), description: errorMessage(err), variant: "destructive" });
    } finally {
      setLogoUploading(false);
    }
  };

  const handleConnectGmail = async () => {
    try {
      const url = await storageService.getGmailAuthUrl();
      window.open(url, "gmail-auth", "width=600,height=700");
    } catch (err) {
      toast({ title: tr("تعذر بدء ربط Gmail", "Could not start Gmail connect"), description: errorMessage(err), variant: "destructive" });
    }
  };

  const updateSeed = (idx: number, patch: Partial<PaperType>) =>
    setSeedPaperTypes((prev) => prev.map((pt, i) => (i === idx ? { ...pt, ...patch } : pt)));

  return (
    <div dir={isRtl ? "rtl" : "ltr"} className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-slate-200 dark:border-gray-800 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-indigo-600 to-indigo-700 dark:from-indigo-700 dark:to-indigo-900 px-6 py-5 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-indigo-200 uppercase tracking-wider">
                {tr(`الخطوة ${stepIndex + 1} من ${steps.length}`, `Step ${stepIndex + 1} of ${steps.length}`)}
              </p>
              <h1 className="text-xl font-bold mt-0.5">{step.title}</h1>
              <p className="text-sm text-indigo-100 mt-0.5">{step.subtitle}</p>
            </div>
            {step.id !== "password" && (
              <button
                type="button"
                onClick={finish}
                className="text-xs font-medium text-indigo-100 hover:text-white underline underline-offset-2"
              >
                {tr("تخطٍّ الآن", "Skip for now")}
              </button>
            )}
          </div>
          {/* Progress dots */}
          <div className="flex items-center gap-1.5 mt-4">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 rounded-full transition-all ${
                  i === stepIndex ? "w-6 bg-white" : i < stepIndex ? "w-3 bg-indigo-300" : "w-3 bg-indigo-400/40"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6 min-h-[280px] text-slate-800 dark:text-slate-100">
          {step.id === "password" && (
            <div className="space-y-4">
              <div>
                <Label>{tr("كلمة المرور الحالية", "Current password")}</Label>
                <Input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder={DEFAULT_PASSWORD} />
                <p className="text-xs text-muted-foreground mt-1">
                  {tr("الافتراضية عند التثبيت الأول هي admin123.", "The default on a fresh install is admin123.")}
                </p>
              </div>
              <div>
                <Label>{tr("كلمة المرور الجديدة", "New password")}</Label>
                <Input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder="••••••••" />
              </div>
              <div>
                <Label>{tr("تأكيد كلمة المرور", "Confirm password")}</Label>
                <Input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="••••••••" />
              </div>
              <p className="text-xs text-muted-foreground">
                {tr("8 أحرف على الأقل، وليست أرقامًا فقط.", "At least 8 characters, not all digits.")}
              </p>
              {pwError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{pwError}</p>}
            </div>
          )}

          {step.id === "shop" && (
            <div className="space-y-4">
              <div>
                <Label>{tr("اسم المتجر", "Shop name")}</Label>
                <Input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder={tr("متجر الطباعة", "My Print Shop")} />
              </div>
              <div>
                <Label>{tr("العملة", "Currency")}</Label>
                <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="DZD" className="max-w-[140px]" />
                <p className="text-xs text-muted-foreground mt-1">
                  {tr("تظهر بجانب الأسعار (مثل DZD أو USD).", "Shown next to prices (e.g. DZD, USD).")}
                </p>
              </div>
              <div>
                <Label>{tr("الشعار", "Logo")}</Label>
                <div className="flex items-center gap-3 mt-1">
                  <div className="w-14 h-14 rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                    {logoUrl ? (
                      <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-xs text-slate-400">{tr("لا يوجد", "None")}</span>
                    )}
                  </div>
                  <label className="cursor-pointer">
                    <span className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium bg-slate-100 dark:bg-gray-800 text-foreground hover:bg-slate-200 dark:hover:bg-gray-700">
                      {logoUploading ? tr("جارٍ الرفع…", "Uploading…") : tr("رفع صورة", "Upload image")}
                    </span>
                    <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={logoUploading} />
                  </label>
                </div>
              </div>
            </div>
          )}

          {step.id === "pricing" && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{tr("سعر الصفحة الملونة", "Color per page")}</Label>
                  <Input type="number" min={0} value={colorPerPage} onChange={(e) => setColorPerPage(parseFloat(e.target.value) || 0)} />
                </div>
                <div>
                  <Label>{tr("سعر صفحة أبيض وأسود", "B&W per page")}</Label>
                  <Input type="number" min={0} value={bwPerPage} onChange={(e) => setBwPerPage(parseFloat(e.target.value) || 0)} />
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold mb-2">{tr("أنواع الورق الأولية", "Initial paper types")}</p>
                <div className="space-y-2">
                  {seedPaperTypes.map((pt, idx) => (
                    <div key={idx} className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-center">
                      <Input value={pt.name} onChange={(e) => updateSeed(idx, { name: e.target.value })} placeholder={tr("الاسم", "Name")} />
                      <Input value={pt.nameAr} onChange={(e) => updateSeed(idx, { nameAr: e.target.value })} placeholder={tr("الاسم بالعربية", "Arabic name")} />
                      <Input type="number" min={0} value={pt.colorPerPage} onChange={(e) => updateSeed(idx, { colorPerPage: parseFloat(e.target.value) || 0 })} placeholder={tr("ملون", "Color")} />
                      <Input type="number" min={0} value={pt.blackWhitePerPage} onChange={(e) => updateSeed(idx, { blackWhitePerPage: parseFloat(e.target.value) || 0 })} placeholder={tr("أ/أ", "B&W")} />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {tr("يمكنك تعديلها لاحقًا من الإعدادات.", "You can refine these later in Settings.")}
                </p>
              </div>
            </div>
          )}

          {step.id === "printer" && (
            <div className="space-y-4">
              <Label>{tr("اختر الطابعة الافتراضية", "Pick the default printer")}</Label>
              {printers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tr("لم يتم العثور على طابعات.", "No printers detected.")}
                </p>
              ) : (
                <Select value={defaultPrinterName} onValueChange={setDefaultPrinterName}>
                  <SelectTrigger>
                    <SelectValue placeholder={tr("اختر طابعة", "Choose a printer")} />
                  </SelectTrigger>
                  <SelectContent>
                    {printers.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.displayName || p.name}
                        {p.isDefault ? tr(" (النظام)", " (system)") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                {tr("تُستخدم للطباعة السريعة بنقرة واحدة.", "Used for one-click Quick Print.")}
              </p>
            </div>
          )}

          {step.id === "cloud" && (
            <div className="space-y-4">
              <div>
                <Label>{tr("رابط المتجر السحابي", "Store link")}</Label>
                <Input value={cloudSyncUrl} onChange={(e) => setCloudSyncUrl(e.target.value)} placeholder="https://print.example.com/s/your-store" />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "الصق الرابط الذي زوّدك به المشرف — يتضمّن معرّف المتجر تلقائيًا.",
                    "Paste the link your platform admin gave you — the store slug is picked up automatically.",
                  )}
                </p>
              </div>
              <div>
                <Label>{tr("رمز المتجر", "Shop token")}</Label>
                <Input value={shopApiToken} onChange={(e) => setShopApiToken(e.target.value)} placeholder="shop_…" />
              </div>
              <p className="text-xs text-muted-foreground">
                {tr("اتركه فارغًا إذا لم تكن تستخدم الاستقبال السحابي.", "Leave blank if you don't use cloud intake.")}
              </p>
            </div>
          )}

          {step.id === "gmail" && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {tr(
                  "اربط حساب Gmail لسحب المرفقات المرسلة كطلبات طباعة. يمكنك تخطي هذه الخطوة وربطه لاحقًا من الإعدادات.",
                  "Connect a Gmail account to pull emailed attachments as print jobs. You can skip this and connect later from Settings.",
                )}
              </p>
              <Button type="button" variant="outline" onClick={handleConnectGmail}>
                {tr("ربط Gmail", "Connect Gmail")}
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-gray-800 flex items-center justify-between bg-slate-50 dark:bg-gray-900/60">
          <Button type="button" variant="ghost" onClick={goBack} disabled={stepIndex === 0 || saving}>
            {tr("رجوع", "Back")}
          </Button>
          <div className="flex items-center gap-2">
            {step.optional && (
              <Button type="button" variant="ghost" onClick={goNext} disabled={saving}>
                {tr("تخطي هذه الخطوة", "Skip this step")}
              </Button>
            )}
            <Button type="button" onClick={handleSaveAndNext} disabled={saving}>
              {saving
                ? tr("جارٍ الحفظ…", "Saving…")
                : isLast
                ? tr("إنهاء", "Finish")
                : tr("حفظ ومتابعة", "Save & continue")}
            </Button>
          </div>
        </div>
      </div>
      <Toaster />
    </div>
  );
};

export default OnboardingWizard;
