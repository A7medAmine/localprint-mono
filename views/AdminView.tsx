import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Language, PrintJob, PrintStatus, PaymentStatus, ShopSettings, DiscountRule, DiscountType, ConditionType, PaperType, PrinterJobDefaults } from "../types";
import { TRANSLATIONS } from "../constants";
import { storageService } from "../services/storageService";
import { isElectron, getPrinters, printFile, PrinterInfo } from "../lib/electronPrint";
import {
  calculatePrintPrice,
  getActualPageCount,
  formatPrice,
  calculateCustomerTotal,
  calculateJobDiscount,
  calculateCustomerTotalWithDiscounts,
} from "../utils/pricingUtils";
import { formatRelativeTime } from "../utils/timeUtils";
import { cn } from "../lib/utils";
import ImageEditor from "../components/ImageEditor";
import { toast } from "../components/ui/use-toast";
import { Toaster } from "../components/ui/toaster";
import { ToastAction } from "../components/ui/toast";
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
import { Switch } from "../components/ui/switch";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import PreviewModal from "../components/preview/PreviewModal";
import QrPosterDialog from "../components/QrPosterDialog";
import LanguageToggle from "../components/LanguageToggle";
import InventorySection from "../components/InventorySection";
import { AdminProvider } from "./admin/AdminContext";
import GmailPanel from "./admin/gmail/GmailPanel";
import ReviewQueuePanel from "./admin/review/ReviewQueuePanel";

interface AdminViewProps {
  lang: Language;
  onLogout: () => void;
  onSettingsUpdate: (settings: ShopSettings) => void;
  currentSettings: ShopSettings;
  darkMode?: boolean;
  themeMode?: "light" | "dark" | "system";
  onToggleDarkMode?: () => void;
  onToggleLang?: (lang: Language) => void;
}

interface CustomerGroup {
  key: string;
  customerName: string;
  phoneNumber: string;
  jobs: PrintJob[];
  latestDate: string;
}

const AdminViewInner: React.FC<AdminViewProps> = ({
  lang,
  onLogout,
  onSettingsUpdate,
  currentSettings,
  darkMode = false,
  themeMode = "system",
  onToggleDarkMode,
  onToggleLang,
}) => {
  // Safe translation function
  const t = (key: string) => {
    if (!TRANSLATIONS[key]) {
      console.warn(`Missing translation key: ${key}`);
      return key;
    }
    return TRANSLATIONS[key][lang] || TRANSLATIONS[key]["en"] || key;
  };

  const isRtl = lang === "ar";
  const navigate = useNavigate();


  // Confirm dialog states
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [singleDeleteConfirm, setSingleDeleteConfirm] = useState<string | null>(null);

  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const validTabs = ["jobs", "settings", "gmail", "review", "inventory"] as const;
  type AdminTab = (typeof validTabs)[number];
  const urlTab = searchParams.get("tab") as AdminTab | null;
  const activeTab: AdminTab = urlTab && validTabs.includes(urlTab) ? urlTab : "jobs";
  const setActiveTab = (next: AdminTab) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "jobs") p.delete("tab");
        else p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  };
  const [lowStockCount, setLowStockCount] = useState(0);
  const [reviewJobs, setReviewJobs] = useState<PrintJob[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());

  const [editingJob, setEditingJob] = useState<PrintJob | null>(null);
  const [editingBlob, setEditingBlob] = useState<Blob | null>(null);
  const [qrPosterOpen, setQrPosterOpen] = useState(false);

  const [shopName, setShopName] = useState(currentSettings.shopName);
  const [logoUrl, setLogoUrl] = useState<string | null>(
    currentSettings.logoUrl,
  );
  const [paperTypes, setPaperTypes] = useState<PaperType[]>(
    currentSettings.paperTypes && currentSettings.paperTypes.length > 0
      ? currentSettings.paperTypes
      : [
          { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: currentSettings.pricing?.colorPerPage || 30.0, blackWhitePerPage: currentSettings.pricing?.blackWhitePerPage || 15.0 },
          { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: currentSettings.pricing?.glossyPerPage || 50.0, blackWhitePerPage: currentSettings.pricing?.glossyPerPage || 50.0 },
          { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: currentSettings.pricing?.cardboardPerPage || 40.0, blackWhitePerPage: currentSettings.pricing?.cardboardPerPage || 40.0 },
        ]
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
  const [jobPageCounts, setJobPageCounts] = useState<{
    [jobId: string]: number;
  }>({});
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [cloudSyncUrl, setCloudSyncUrl] = useState(currentSettings.cloudSyncUrl || "");
  const [shopApiToken, setShopApiToken] = useState(currentSettings.shopApiToken || "");
  const [cloudSyncPollInterval, setCloudSyncPollInterval] = useState(currentSettings.cloudSyncPollInterval || "30000");
  const [autoAcceptCloudJobs, setAutoAcceptCloudJobs] = useState(currentSettings.autoAcceptCloudJobs !== false);
  const [autoDeductStock, setAutoDeductStock] = useState(currentSettings.autoDeductStock === true);
  // Printers (Electron-only surface). `printers` is populated on demand from
  // the main-process IPC; empty in a plain browser session.
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [defaultPrinterName, setDefaultPrinterName] = useState<string>(currentSettings.defaultPrinterName || "");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>(
    currentSettings.printerDefaults || {},
  );

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [previewJob, setPreviewJob] = useState<PrintJob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [paymentEditJob, setPaymentEditJob] = useState<PrintJob | null>(null);
  const [paymentEditStatus, setPaymentEditStatus] = useState<string>(PaymentStatus.UNPAID);
  const [paymentEditAmount, setPaymentEditAmount] = useState<number>(0);
  const [backupRestoreOpen, setBackupRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  const handlePreview = async (job: PrintJob) => {
    const url = await storageService.getFileUrl(job.id);
    if (url) {
      setPreviewJob(job);
      setPreviewUrl(url);
    }
  };

  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());

  const toggleNoteExpand = (id: string) => {
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Tracks which job's copies stepper is open
  const [editingCopiesJobId, setEditingCopiesJobId] = useState<string | null>(
    null,
  );
  // Tracks which job is currently saving preferences (shows spinner)
  const [savingPrefsJobId, setSavingPrefsJobId] = useState<string | null>(null);
  // Local copies value while editing
  const [editingCopiesValue, setEditingCopiesValue] = useState<number>(1);

  const [searchQuery, setSearchQuery] = useState("");
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

  // The sidebar badge must be accurate before the Inventory tab is ever opened.
  const loadLowStockCount = async () => {
    try {
      const { lowStockCount: count } = await storageService.getInventory();
      setLowStockCount(count);
    } catch (err) {
      console.error("Failed to load low stock count:", err);
    }
  };

  useEffect(() => {
    loadJobs();
    loadDiscountRules();
    loadLowStockCount();

    // SSE listener — real-time updates. The persistent new-email toast lives
    // here so it fires on any tab; GmailPanel owns the pending list itself.
    const es = new EventSource('/api/events');
    es.addEventListener("gmail-new", (e) => {
      try {
        const data = JSON.parse(e.data);
        const count = data.new || 0;
        if (count > 0) {
          toast({ title: `${count} ${isRtl ? "بريد جديد" : "new email(s)"} ${isRtl ? "وصل" : "received"}`, variant: "success" });
          new Audio('/notification.mp3').play().catch(() => {});
        }
      } catch {}
    });
    es.addEventListener("new-job", () => { loadJobs(); });
    es.addEventListener("cloud-job-imported", (e) => {
      try {
        const data = JSON.parse(e.data);
        const label = data.customerName ? `${data.customerName} — ${data.fileName}` : data.fileName;
        toast({ title: isRtl ? `طلب جديد من الرفع الإلكتروني: ${label}` : `New online upload: ${label}`, variant: "success" });
        new Audio('/notification.mp3').play().catch(() => {});
      } catch {}
      loadJobs();
    });
    es.addEventListener("job-deleted", () => { loadJobs(); });
    es.onerror = () => {};
    return () => { es.close(); };
  }, []);

  // Load current settings when component mounts
  useEffect(() => {
    setShopName(currentSettings.shopName);
    setLogoUrl(currentSettings.logoUrl);
    if (currentSettings.paperTypes && currentSettings.paperTypes.length > 0) {
      setPaperTypes(currentSettings.paperTypes);
    }
    if (currentSettings.phoneNumbers) setPhoneNumbers(currentSettings.phoneNumbers);
    if (currentSettings.email) setEmail(currentSettings.email);
    if (currentSettings.address) setAddress(currentSettings.address);
    if (currentSettings.workingHours) setWorkingHours(currentSettings.workingHours);
    if (currentSettings.returnPolicy) setReturnPolicy(currentSettings.returnPolicy);
    if (currentSettings.cloudSyncUrl) setCloudSyncUrl(currentSettings.cloudSyncUrl);
    if (currentSettings.shopApiToken) setShopApiToken(currentSettings.shopApiToken);
    if (currentSettings.cloudSyncPollInterval) setCloudSyncPollInterval(currentSettings.cloudSyncPollInterval);
    setAutoAcceptCloudJobs(currentSettings.autoAcceptCloudJobs !== false);
    setAutoDeductStock(currentSettings.autoDeductStock === true);
    setDefaultPrinterName(currentSettings.defaultPrinterName || "");
    setPrinterDefaults(currentSettings.printerDefaults || {});
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

  // Enumerate printers on mount so the settings section is ready without
  // an extra click. Cheap enough (Chromium caches it) that eager-loading
  // is fine.
  useEffect(() => {
    loadPrinters();
  }, [loadPrinters]);

  const loadJobs = async () => {
    setLoading(true);
    const allData = await storageService.getMetadata();
    const data = allData.filter((j) => (j.status as string) !== 'pending_review');
    setReviewJobs(allData.filter((j) => (j.status as string) === 'pending_review'));
    const grouped = data.reduce(
      (acc: { [key: string]: CustomerGroup }, job) => {
        const name = job.customerName?.trim() || "";
        const phone = job.phoneNumber?.trim() || "";

        let key = `${name}-${phone}`;
        if (!name && !phone) {
          // Group anonymous files by the exact minute they were uploaded
          const timeKey = new Date(job.uploadDate).toISOString().slice(0, 16);
          key = `anon-${timeKey}`;
        }

        if (!acc[key]) {
          acc[key] = {
            key,
            customerName: name,
            phoneNumber: phone,
            jobs: [],
            latestDate: job.uploadDate,
          };
        }
        acc[key].jobs.push(job);
        if (new Date(job.uploadDate) > new Date(acc[key].latestDate)) {
          acc[key].latestDate = job.uploadDate;
        }
        return acc;
      },
      {},
    );

    const sortedGroups = Object.values(grouped).sort(
      (a, b) =>
        new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime(),
    );

    sortedGroups.forEach((group) => {
      group.jobs.sort(
        (a, b) =>
          new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime(),
      );
    });

    setGroups(sortedGroups);
    setLoading(false);

    // Count pages for all jobs
    countPagesForAllJobs(sortedGroups);
  };

  const countPagesForAllJobs = async (groups: CustomerGroup[]) => {
    const pageCounts: { [jobId: string]: number } = {};

    // Pre-seed with server-provided page counts (already accurate for PDFs)
    for (const group of groups) {
      for (const job of group.jobs) {
        if (job.pageCount && job.pageCount > 0) {
          pageCounts[job.id] = job.pageCount;
        }
      }
    }

    // Only fetch & count client-side for jobs without a server page count
    for (const group of groups) {
      for (const job of group.jobs) {
        if (pageCounts[job.id]) continue; // already have it
        try {
          const url = await storageService.getFileUrl(job.id);
          if (url) {
            const response = await fetch(url);
            const blob = await response.blob();
            const file = new File([blob], job.fileName, { type: job.fileType });
            const pageCount = await getActualPageCount(file);
            pageCounts[job.id] = pageCount;
          } else {
            pageCounts[job.id] = 1;
          }
        } catch (error) {
          console.error(`Error counting pages for job ${job.id}:`, error);
          pageCounts[job.id] = 1;
        }
      }
    }

    setJobPageCounts(pageCounts);
  };

  // Discount Rules Functions
  const loadDiscountRules = async () => {
    try {
      const rules = await storageService.getDiscountRules();
      setDiscountRules(rules);
    } catch (err) {
      console.error("Failed to load discount rules:", err);
    }
  };

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
      loadDiscountRules();
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
        loadDiscountRules();
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
      loadDiscountRules();
      toast({ title: !rule.is_active ? (isRtl ? "تم تفعيل القاعدة" : "Rule activated") : (isRtl ? "تم تعطيل القاعدة" : "Rule deactivated"), variant: "success" });
    } catch (err) {
      console.error("Failed to toggle rule:", err);
      toast({ title: isRtl ? "فشل تحديث القاعدة" : "Failed to update rule", variant: "destructive" });
    }
  };

  const toggleGroup = (key: string) => {
    const newCollapsed = new Set(collapsedGroups);
    if (newCollapsed.has(key)) {
      newCollapsed.delete(key);
    } else {
      newCollapsed.add(key);
    }
    setCollapsedGroups(newCollapsed);
  };

  const toggleSelectJob = (id: string) => {
    const newSelected = new Set(selectedJobIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedJobIds(newSelected);
  };

  const toggleSelectGroup = (
    jobs: PrintJob[],
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const jobIds = jobs.map((j) => j.id);
    const allSelectedInGroup = jobIds.every((id) => selectedJobIds.has(id));

    const newSelected = new Set(selectedJobIds);
    if (allSelectedInGroup) {
      jobIds.forEach((id) => newSelected.delete(id));
    } else {
      jobIds.forEach((id) => newSelected.add(id));
    }
    setSelectedJobIds(newSelected);
  };

  const handleDownload = async (job: PrintJob) => {
    const url = await storageService.getFileUrl(job.id);
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.download = job.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // Native printing (Electron). Everything below routes through the
  // print-file IPC — the old "window.open + window.print" flow only made
  // sense when this ran in a plain browser, and it never gave us silent
  // printing or per-printer defaults. Office docs get handed to the OS
  // registered app via shell.openPath (same channel, different branch in
  // electron/main.js).

  const defaultsForActivePrinter = (): PrinterJobDefaults | null => {
    if (!defaultPrinterName) return null;
    return printerDefaults[defaultPrinterName] || null;
  };

  // Return signal for bulk mode. "ok" = queued at driver, "cancelled" = user
  // dismissed the dialog (bulk should stop, not continue), "error" = failed,
  // "unsupported" = precondition (no default printer, no file path, not
  // Electron) — bulk should stop too since the same precondition applies to
  // every remaining job.
  type PrintOutcome = "ok" | "cancelled" | "error" | "unsupported";

  const printJobViaIpc = async (
    job: PrintJob,
    mode: "quick" | "options" | "open",
    opts?: { silentToasts?: boolean },
  ): Promise<PrintOutcome> => {
    const silentToasts = opts?.silentToasts === true;
    const maybeToast = (t: Parameters<typeof toast>[0]) => {
      if (!silentToasts) toast(t);
    };

    if (!isElectron()) {
      maybeToast({
        title: isRtl ? "الطباعة الأصلية غير متوفرة" : "Native printing unavailable",
        description: isRtl
          ? "افتح التطبيق من سطح المكتب للطباعة."
          : "Open the desktop app to print.",
        variant: "destructive",
      });
      return "unsupported";
    }

    const filePath = await storageService.getFileLocalPath(job.id);
    if (!filePath) {
      maybeToast({
        title: isRtl ? "تعذر تحديد مسار الملف" : "Could not resolve file path",
        description: job.fileName,
        variant: "destructive",
      });
      return "error";
    }

    // Office docs — no printer/options; the OS handler takes over.
    if (mode === "open") {
      try {
        const result = await printFile({ filePath, fileType: job.fileType });
        if (result.ok) {
          maybeToast({
            title: isRtl ? "تم فتح الملف في التطبيق الافتراضي" : "Opened in default app",
            description: job.fileName,
            variant: "success",
          });
          return "ok";
        }
        return "error";
      } catch (err) {
        maybeToast({
          title: isRtl ? "تعذر فتح الملف" : "Failed to open file",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
        return "error";
      }
    }

    // Quick Print requires a saved default printer — without one, silent
    // printing would fall through to "whatever Chromium picks" which is
    // exactly the surprise this feature is supposed to prevent.
    if (mode === "quick" && !defaultPrinterName) {
      maybeToast({
        title: isRtl ? "لم يتم تعيين طابعة افتراضية" : "No default printer set",
        description: isRtl
          ? "اختر طابعة افتراضية من الإعدادات."
          : "Pick a default printer in Settings.",
        variant: "destructive",
      });
      return "unsupported";
    }

    // The job already carries the customer's chosen copies + color mode
    // (see printPreferences). Those beat the printer's saved defaults —
    // duplex/collate/landscape still come from the printer defaults since
    // they're printer-hardware concerns, not per-order choices.
    const defaults = defaultsForActivePrinter();
    const jobCopies = Math.max(1, Number(job.printPreferences?.copies) || 1);
    const jobColor = job.printPreferences?.colorMode
      ? job.printPreferences.colorMode !== "blackWhite"
      : defaults?.color ?? true;
    const options = {
      duplexMode: defaults?.duplexMode ?? "simplex",
      color: jobColor,
      copies: jobCopies,
      collate: defaults?.collate ?? true,
      landscape: defaults?.landscape ?? false,
    };

    try {
      const result = await printFile({
        filePath,
        fileType: job.fileType,
        // Options dialog: empty deviceName lets the OS dialog show every
        // printer, pre-selected to none — the user picks. Silent: always
        // route to the saved default.
        printerName: mode === "quick" ? defaultPrinterName : (defaultPrinterName || ""),
        silent: mode === "quick",
        options,
      });
      if (result.cancelled) {
        maybeToast({ title: isRtl ? "تم إلغاء الطباعة" : "Print cancelled" });
        return "cancelled";
      }
      if (result.ok) {
        maybeToast({
          title: mode === "quick"
            ? (isRtl ? "تم إرسال المهمة" : "Sent to printer")
            : (isRtl ? "تم إرسال المهمة" : "Print job submitted"),
          description: job.fileName,
          variant: "success",
        });
        return "ok";
      }
      return "error";
    } catch (err) {
      maybeToast({
        title: isRtl ? "فشل الطباعة" : "Print failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      return "error";
    }
  };

  const handleQuickPrint = (job: PrintJob) => printJobViaIpc(job, "quick");
  const handlePrintOptions = (job: PrintJob) => printJobViaIpc(job, "options");
  const handleOpenInApp = (job: PrintJob) => printJobViaIpc(job, "open");

  const [bulkPrinting, setBulkPrinting] = useState(false);

  const handleBulkPrint = async () => {
    const selectedJobs = groups
      .flatMap((g) => g.jobs)
      .filter((j) => selectedJobIds.has(j.id));
    if (selectedJobs.length === 0 || bulkPrinting) return;

    setBulkPrinting(true);
    let sent = 0;
    let failed = 0;
    const failedNames: string[] = [];
    let cancelled = false;

    // Sequential + inter-job settle. Two back-to-back nativePrint windows
    // race Chromium's compositor teardown/spinup and reproduce the "second
    // job prints black" bug we thought we killed. A short pause between
    // jobs (>= the print window's own settle) is enough to keep them from
    // clobbering each other. Also: stop early on a cancel — the user
    // dismissed a dialog, they don't want the rest to keep firing.
    const INTER_JOB_MS = 400;

    try {
      for (let i = 0; i < selectedJobs.length; i++) {
        const job = selectedJobs[i];
        const mode = isOfficeFile(job.fileType) ? "open" : "quick";
        const outcome = await printJobViaIpc(job, mode, { silentToasts: true });
        if (outcome === "cancelled") {
          cancelled = true;
          break;
        }
        if (outcome === "unsupported") {
          // Same precondition will fail every remaining job — bail with a
          // single explanatory toast instead of N identical ones.
          toast({
            title: isRtl ? "الطباعة السريعة غير متاحة" : "Quick Print unavailable",
            description: isRtl
              ? "اختر طابعة افتراضية من الإعدادات."
              : "Set a default printer in Settings, then try again.",
            variant: "destructive",
          });
          setBulkPrinting(false);
          return;
        }
        if (outcome === "ok") sent++;
        else {
          failed++;
          failedNames.push(job.fileName);
        }
        // Don't sleep after the last job.
        if (i < selectedJobs.length - 1) {
          await new Promise((r) => setTimeout(r, INTER_JOB_MS));
        }
      }
    } finally {
      setBulkPrinting(false);
    }

    // One summary toast at the end instead of N per-job toasts.
    if (cancelled) {
      toast({
        title: isRtl ? "تم إيقاف الطباعة الجماعية" : "Bulk print stopped",
        description: isRtl
          ? `أُرسل ${sent} من ${selectedJobs.length} قبل الإلغاء.`
          : `Sent ${sent} of ${selectedJobs.length} before cancel.`,
      });
    } else if (failed === 0) {
      toast({
        title: isRtl ? `تم إرسال ${sent} مهمة` : `Sent ${sent} job${sent === 1 ? "" : "s"}`,
        variant: "success",
      });
    } else {
      toast({
        title: isRtl
          ? `أُرسل ${sent}، فشل ${failed}`
          : `${sent} sent, ${failed} failed`,
        description: failedNames.slice(0, 3).join(", ") + (failedNames.length > 3 ? "…" : ""),
        variant: "destructive",
      });
    }
  };

  const handleBulkDownload = async () => {
    const selectedIds = Array.from(selectedJobIds);
    for (let i = 0; i < selectedIds.length; i++) {
      const job = groups
        .flatMap((g) => g.jobs)
        .find((j) => j.id === selectedIds[i]);
      if (job) {
        await handleDownload(job);
        if (selectedIds.length > 1)
          await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  const handleBulkDelete = () => {
    setBulkDeleteConfirm(true);
  };

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkDeleteJobs(ids);
      setSelectedJobIds(new Set());
      setBulkDeleteConfirm(false);
      loadJobs();
      toast({ title: isRtl ? `تم حذف ${ids.length} ملفات` : `${ids.length} files deleted successfully`, variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", variant: "destructive" });
    }
  };

  const handleBulkStatusUpdate = async (status: PrintStatus = PrintStatus.PRINTED) => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkUpdateStatus(ids, status);
      setSelectedJobIds(new Set());
      loadJobs();
      if (status === PrintStatus.PRINTED) loadLowStockCount();
      toast({ title: isRtl ? `تم تحديث ${ids.length} ملفات` : `${ids.length} files updated`, variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل التحديث" : "Update failed", variant: "destructive" });
    }
  };

  const handleEdit = async (job: PrintJob) => {
    if (job.fileType.includes("pdf")) {
      sessionStorage.setItem("ps_edit_job", job.id);
      navigate("/admin/studio");
    } else {
      const url = await storageService.getFileUrl(job.id);
      if (url && job.fileType.includes("image")) {
        const res = await fetch(url);
        const blob = await res.blob();
        setEditingJob(job);
        setEditingBlob(blob);
      } else {
        toast({ title: isRtl ? "تحرير الصور متاح لملفات الصور فقط." : "Editing is only for image files.", variant: "destructive" });
      }
    }
  };

  const handleSaveEditedImage = async (newBlob: Blob) => {
    if (editingJob) {
      try {
        const file = new File([newBlob], editingJob.fileName, {
          type: newBlob.type,
        });
        await storageService.updateJobFile(editingJob.id, file);
        setEditingJob(null);
        setEditingBlob(null);
        loadJobs();
        toast({ title: isRtl ? "تم تحديث الملف بنجاح" : "File updated successfully", variant: "success" });
      } catch (err) {
        console.error("Failed to update job file:", err);
        toast({ title: isRtl ? "فشل تحديث الملف." : "Failed to update file.", variant: "destructive" });
      }
    }
  };

  const handleStatusChange = async (jobId: string, newStatus: PrintStatus) => {
    // Optimistic update — patch the single job in-place so the list doesn't
    // rebuild (avoids the skeleton flash, scroll jump, and lost expand state).
    let previousStatus: PrintStatus | undefined;
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        jobs: g.jobs.map((j) => {
          if (j.id !== jobId) return j;
          previousStatus = j.status;
          return { ...j, status: newStatus };
        }),
      })),
    );

    try {
      await storageService.updateStatus(jobId, newStatus);
      // Marking a job printed can auto-deduct paper, so the badge may have moved.
      if (newStatus === PrintStatus.PRINTED) loadLowStockCount();
    } catch (err) {
      // Roll back on failure.
      if (previousStatus !== undefined) {
        const rollbackTo = previousStatus;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            jobs: g.jobs.map((j) => (j.id === jobId ? { ...j, status: rollbackTo } : j)),
          })),
        );
      }
      toast({ title: isRtl ? "فشل تحديث الحالة" : "Failed to update status", variant: "destructive" });
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

  const handlePaymentClick = (job: PrintJob) => {
    setPaymentEditJob(job);
    setPaymentEditStatus(job.paymentStatus || PaymentStatus.UNPAID);
    setPaymentEditAmount(job.paymentAmount || 0);
  };

  const handleSavePayment = async () => {
    if (!paymentEditJob) return;
    try {
      await storageService.updatePaymentStatus(paymentEditJob.id, paymentEditStatus, paymentEditAmount);
      setPaymentEditJob(null);
      loadJobs();
      toast({ title: isRtl ? "تم تحديث حالة الدفع" : "Payment status updated", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل تحديث الدفع" : "Failed to update payment", variant: "destructive" });
    }
  };

  const handleBulkPaymentStatus = async (status: string) => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkUpdatePayment(ids, status);
      setSelectedJobIds(new Set());
      loadJobs();
      toast({ title: `${ids.length} ${isRtl ? "تم تحديث الدفع" : "payment(s) updated"}`, variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل" : "Failed", variant: "destructive" });
    }
  };

  const handleBackupDownload = () => {
    storageService.downloadBackup();
  };

  const handleBackupRestore = async () => {
    if (!restoreFile) return;
    setRestoring(true);
    try {
      const result = await storageService.restoreBackup(restoreFile);
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

  const handleDelete = (id: string) => {
    setSingleDeleteConfirm(id);
  };

  const confirmSingleDelete = async () => {
    if (singleDeleteConfirm) {
      await storageService.deleteJob(singleDeleteConfirm);
      const newSelected = new Set(selectedJobIds);
      newSelected.delete(singleDeleteConfirm);
      setSelectedJobIds(newSelected);
      setSingleDeleteConfirm(null);
      loadJobs();
      toast({ title: isRtl ? "تم الحذف بنجاح" : "Deleted successfully", variant: "success" });
    }
  };

  // Toggle color mode for a job inline
  const handlePaperTypeChange = async (job: PrintJob, newPaperType: string) => {
    if (savingPrefsJobId === job.id) return;
    const colorMode = job.printPreferences?.colorMode || "color";
    const copies = job.printPreferences?.copies || 1;
    setSavingPrefsJobId(job.id);
    try {
      await storageService.updateJobPreferences(job.id, { colorMode, copies, paperType: newPaperType });
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          jobs: g.jobs.map((j) =>
            j.id === job.id
              ? { ...j, printPreferences: { colorMode, copies, paperType: newPaperType } }
              : j,
          ),
        })),
      );
    } catch (err) {
      console.error("Failed to update paper type", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  const handleToggleColorMode = async (job: PrintJob) => {
    if (savingPrefsJobId === job.id) return;
    const newMode =
      job.printPreferences?.colorMode === "blackWhite" ? "color" : "blackWhite";
    const newCopies = job.printPreferences?.copies || 1;
    const paperType = job.printPreferences?.paperType || "normal";
    setSavingPrefsJobId(job.id);
    try {
      await storageService.updateJobPreferences(job.id, {
        colorMode: newMode,
        copies: newCopies,
        paperType,
      });
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          jobs: g.jobs.map((j) =>
            j.id === job.id
              ? { ...j, printPreferences: { colorMode: newMode, copies: newCopies, paperType } }
              : j,
          ),
        })),
      );
    } catch (err) {
      console.error("Failed to update color mode", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  // Save updated copies count for a job
  const handleSaveCopies = async (job: PrintJob, copies: number) => {
    if (savingPrefsJobId === job.id) return;
    const safeCopies = Math.max(1, Math.min(100, copies));
    const colorMode = job.printPreferences?.colorMode || "color";
    const paperType = job.printPreferences?.paperType || "normal";
    setSavingPrefsJobId(job.id);
    setEditingCopiesJobId(null);
    try {
      await storageService.updateJobPreferences(job.id, {
        colorMode,
        copies: safeCopies,
        paperType,
      });
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          jobs: g.jobs.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  printPreferences: { colorMode, copies: safeCopies, paperType },
                }
              : j,
          ),
        })),
      );
    } catch (err) {
      console.error("Failed to update copies", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  const getPaperTypeName = (id: string) => {
    const pt = paperTypes.find(p => p.id === id);
    if (!pt) return isRtl ? "عادي" : "Normal";
    return isRtl ? pt.nameAr : pt.name;
  };

  const handleAddPaperType = () => {
    if (!newPaperTypeForm.name.trim()) return;
    const newId = `pt_${Date.now()}`;
    const newPt: PaperType = { id: newId, name: newPaperTypeForm.name.trim(), nameAr: newPaperTypeForm.nameAr.trim() || newPaperTypeForm.name.trim(), colorPerPage: newPaperTypeForm.colorPerPage, blackWhitePerPage: newPaperTypeForm.blackWhitePerPage };
    setPaperTypes(prev => [...prev, newPt]);
    setShowAddPaperTypeForm(false);
    setNewPaperTypeForm({ name: "", nameAr: "", colorPerPage: 30, blackWhitePerPage: 15 });
    toast({ title: isRtl ? "تم إضافة نوع الورق. لا تنس حفظ الإعدادات!" : "Paper type added. Don't forget to save settings!", variant: "success" });
  };

  const handleSavePaperType = (id: string) => {
    if (!editingPaperTypeForm) return;
    setPaperTypes(prev => prev.map(pt => pt.id === id ? { ...pt, ...editingPaperTypeForm } : pt));
    setEditingPaperTypeId(null);
    setEditingPaperTypeForm(null);
  };

  const handleDeletePaperType = (id: string) => {
    setPaperTypes(prev => prev.filter(pt => pt.id !== id));
  };

  const saveSettings = async () => {
    await storageService.saveSettings({ shopName, paperTypes, phoneNumbers, email, address, workingHours, returnPolicy, cloudSyncUrl, shopApiToken, cloudSyncPollInterval, autoAcceptCloudJobs, autoDeductStock, defaultPrinterName, printerDefaults });
    onSettingsUpdate({ ...currentSettings, shopName, paperTypes, phoneNumbers, email, address, workingHours, returnPolicy, cloudSyncUrl, shopApiToken, cloudSyncPollInterval, autoAcceptCloudJobs, autoDeductStock, defaultPrinterName, printerDefaults });
    toast({ title: isRtl ? "تم الحفظ بنجاح" : "Settings saved successfully", variant: "success" });
  };

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

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getFileExtension = (filename: string | null | undefined) => {
    if (!filename) return "";
    return filename.split(".").pop()?.toUpperCase() || "";
  };

  const isOfficeFile = (fileType: string | null | undefined) => {
    if (!fileType) return false;
    return (
      fileType.includes("wordprocessingml.document") ||
      fileType.includes("msword") ||
      fileType.includes("spreadsheetml.sheet") ||
      fileType.includes("ms-excel") ||
      fileType.includes("presentationml.presentation") ||
      fileType.includes("ms-powerpoint")
    );
  };

  const navItems = [
    { id: "dashboard", label: isRtl ? "لوحة المعلومات" : "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
    { id: "review", label: isRtl ? "مراجعة الطلبات" : "Job Review", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", badge: reviewJobs.length },
    { id: "inventory", label: isRtl ? "المخزون" : "Inventory", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", badge: lowStockCount },
    { id: "settings", label: t("settings"), icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
    { id: "gmail", label: isRtl ? "البريد الإلكتروني" : "Email", icon: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
  ];

  const activeNav = activeTab === "gmail" ? "gmail" : activeTab === "settings" ? "settings" : activeTab === "review" ? "review" : activeTab === "inventory" ? "inventory" : "dashboard";

  return (
    <div className="flex h-screen overflow-hidden bg-[#F8FAFC] dark:bg-gray-950">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-[220px] flex-shrink-0 flex flex-col bg-gray-50 dark:bg-[#111] border-r border-gray-200 dark:border-gray-800 transition-transform duration-250 ease md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${isRtl ? "font-['IBMPlexArabic']" : ""}`}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center text-white overflow-hidden shadow-sm flex-shrink-0">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm-1 9H8v2h4v-2z" clipRule="evenodd" />
            </svg>
          </div>
          <span dir="auto" className="text-base font-bold tracking-tight text-gray-900 dark:text-gray-100 truncate">
            {currentSettings.shopName || TRANSLATIONS.appTitle[lang]}
          </span>
        </div>

        {/* Section: MAIN */}
        <div className="px-4 pt-6 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
            {isRtl ? "رئيسي" : "MAIN"}
          </span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-2 space-y-0.5">
          {navItems.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (item.id !== "dashboard") setActiveTab(item.id as any);
                  else setActiveTab("jobs");
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 ease ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/20"
                    : "text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
                }`}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d={item.icon} />
                </svg>
                <span className="flex-1 text-start">{item.label}</span>
                {!!item.badge && (
                  <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${isActive ? "bg-white/20 text-white" : "bg-red-500 text-white"}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Section: TOOLS */}
        <div className="px-4 pt-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
            {isRtl ? "أدوات" : "TOOLS"}
          </span>
        </div>

        <nav className="px-3 pb-2 space-y-0.5">
          <button
            onClick={() => { navigate("/admin/studio"); setSidebarOpen(false); }}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors duration-150 ease"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            {isRtl ? "استوديو الطباعة" : "Print Studio"}
          </button>
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Dark mode + Language toggles */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={onToggleDarkMode}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
            aria-label={
              themeMode === "light"
                ? lang === "ar" ? "الوضع الفاتح" : "Light mode"
                : themeMode === "dark"
                ? lang === "ar" ? "الوضع الليلي" : "Dark mode"
                : lang === "ar" ? "حسب النظام" : "System theme"
            }
            title={
              themeMode === "light"
                ? lang === "ar" ? "فاتح" : "Light"
                : themeMode === "dark"
                ? lang === "ar" ? "داكن" : "Dark"
                : lang === "ar" ? "حسب النظام" : "System"
            }
          >
            {themeMode === "light" ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : themeMode === "dark" ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            )}
          </button>
          {onToggleLang && <LanguageToggle currentLang={lang} onToggle={onToggleLang} />}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header with hamburger */}
        <div className="md:hidden flex items-center justify-between px-4 py-2.5 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {currentSettings.shopName || TRANSLATIONS.appTitle[lang]}
          </span>
          <div className="w-5" />
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto bg-white dark:bg-gray-900">
          <div className={`p-8 ${isRtl ? "rtl text-right" : ""} text-gray-900 dark:text-gray-100`}>
            {editingJob && editingBlob && (
              <ImageEditor
                imageBlob={editingBlob}
                lang={lang}
                onSave={handleSaveEditedImage}
                onCancel={() => {
                  setEditingJob(null);
                  setEditingBlob(null);
                }}
              />
            )}

            {/* Bulk Action Bar */}
            {selectedJobIds.size > 0 && (
              <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[90] bg-gray-900/90 backdrop-blur-md text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-6 animate-slide-up border border-white/10 max-w-[95vw] md:max-w-max">
                <div className="flex items-center gap-3 border-r border-white/20 pr-6 mr-2">
                  <span className="bg-indigo-50 dark:bg-indigo-900/20 text-white dark:text-gray-100 w-7 h-7 rounded-full flex items-center justify-center font-bold text-sm">
                    {selectedJobIds.size}
                  </span>
                  <span className="text-sm font-medium whitespace-nowrap">
                    {t("selectedItems")}
                  </span>
                </div>

                <div className="flex items-center gap-2 md:gap-4">
                  <Button variant="ghost" size="sm" onClick={handleBulkPrint} title={t("bulkPrint")} className="flex-col gap-1 h-auto text-inherit hover:text-indigo-400 dark:hover:text-indigo-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("print")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleBulkDownload} title={t("bulkDownload")} className="flex-col gap-1 h-auto text-inherit hover:text-indigo-400 dark:hover:text-indigo-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("download")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkStatusUpdate(PrintStatus.PRINTED)} title={t("markAsPrinted")} className="flex-col gap-1 h-auto text-inherit hover:text-green-400 dark:hover:text-green-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("printed")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkStatusUpdate(PrintStatus.READY)} title={t("markReady")} className="flex-col gap-1 h-auto text-inherit hover:text-blue-400 dark:hover:text-blue-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("ready")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkPaymentStatus(PaymentStatus.PAID)} title={t("markPaid")} className="flex-col gap-1 h-auto text-inherit hover:text-green-400 dark:hover:text-green-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("paid")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkPaymentStatus(PaymentStatus.UNPAID)} title={t("markUnpaid")} className="flex-col gap-1 h-auto text-inherit hover:text-red-400 dark:hover:text-red-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("unpaid")}</span>
                  </Button>
                  {(() => {
                    const allJobs = groups.flatMap(g => g.jobs);
                    const selectedJobs = allJobs.filter(j => selectedJobIds.has(j.id));
                    const selectedImages = selectedJobs.filter(j => j.fileType?.startsWith("image/"));
                    const showCardBtn = selectedImages.length === 2 && selectedJobs.length === 2;
                    return showCardBtn ? (
                      <Button variant="ghost" size="sm" onClick={() => {
                        const [front, back] = selectedImages;
                        sessionStorage.setItem("ps_card_front", front.id);
                        sessionStorage.setItem("ps_card_back", back.id);
                        navigate("/admin/studio");
                      }} title="Print as Card" className="flex-col gap-1 h-auto text-inherit hover:text-pink-400 dark:hover:text-pink-300">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                        <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{isRtl ? "بطاقة" : "Card"}</span>
                      </Button>
                    ) : null;
                  })()}
                  <Button variant="ghost" size="sm" onClick={handleBulkDelete} title={t("bulkDelete")} className="flex-col gap-1 h-auto text-inherit hover:text-red-400 dark:hover:text-red-300">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    <span className="text-[10px] hidden sm:block uppercase tracking-wider font-bold">{t("delete")}</span>
                  </Button>
                </div>

                <Button variant="ghost" size="icon" onClick={() => setSelectedJobIds(new Set())} className="ml-4 text-white hover:bg-white dark:bg-gray-800/10">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </Button>
              </div>
            )}

      <div className="min-h-0">
        {activeTab === "jobs" ? (
          <>
            {/* Stats Summary Bar */}
            {!loading && groups.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mb-3">
                <div className="bg-white dark:bg-gray-800 rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-yellow-600 dark:text-yellow-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-yellow-600 dark:text-yellow-200 leading-none">{groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.PENDING).length, 0)}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{isRtl ? "قيد الانتظار" : "Pending"}</span>
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-blue-600 dark:text-blue-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"/></svg>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-blue-600 dark:text-blue-200 leading-none">{groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.READY).length, 0)}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{isRtl ? "جاهز للاستلام" : "Ready"}</span>
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-green-600 dark:text-green-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-green-600 dark:text-green-200 leading-none">{groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.PRINTED).length, 0)}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{isRtl ? "تمت الطباعة" : "Printed"}</span>
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-indigo-600 dark:text-indigo-200 leading-none">{groups.length}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{isRtl ? "إجمالي العملاء" : "Customers"}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Search Bar */}
            {!loading && groups.length > 0 && (
              <div className="relative my-3">
                <div className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500`}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                </div>
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isRtl ? "ابحث بالاسم أو رقم الهاتف..." : "Search by name or phone..."}
                  className={`${isRtl ? "pr-9 pl-4" : "pl-9 pr-4"}`}
                />
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSearchQuery("")}
                    className={`absolute ${isRtl ? "left-1" : "right-1"} top-1/2 -translate-y-1/2 h-7 w-7`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
                  </Button>
                )}
              </div>
            )}

            {(() => {
              const filteredGroups = searchQuery.trim()
                ? groups.filter(
                    (g) =>
                      g.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      g.phoneNumber.includes(searchQuery)
                  )
                : groups;
              return (
            <>
            {loading ? (
              <div className="space-y-3 animate-pulse">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <div className="flex items-center px-4 py-3 gap-3 border-b border-gray-100 dark:border-gray-700">
                      <div className="w-4 h-4 rounded bg-gray-200 dark:bg-gray-700 shrink-0" />
                      <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3.5 w-36 rounded-full bg-gray-200 dark:bg-gray-700" />
                        <div className="h-3 w-24 rounded-full bg-gray-100 dark:bg-gray-800" />
                      </div>
                      <div className="h-5 w-16 rounded-full bg-gray-200 dark:bg-gray-700" />
                      <div className="h-5 w-5 rounded bg-gray-200 dark:bg-gray-700" />
                    </div>
                    <div className="px-4 py-2 space-y-2">
                      {[1, 2].map((j) => (
                        <div key={j} className="flex items-center gap-3 min-h-[80px] py-2">
                          <div className="w-4 h-4 rounded bg-gray-200 dark:bg-gray-700 shrink-0" />
                          <div className="w-10 h-10 rounded bg-gray-200 dark:bg-gray-700 shrink-0" />
                          <div className="flex-1 space-y-1">
                            <div className="h-3 w-44 rounded-full bg-gray-200 dark:bg-gray-700" />
                            <div className="h-2.5 w-28 rounded-full bg-gray-100 dark:bg-gray-800" />
                          </div>
                          <div className="h-5 w-16 rounded-full bg-gray-200 dark:bg-gray-700" />
                          <div className="h-5 w-12 rounded-full bg-gray-200 dark:bg-gray-700" />
                          <div className="flex gap-1">
                            <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700" />
                            <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700" />
                            <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700" />
                            <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="px-6 py-14 sm:py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="max-w-sm mx-auto flex flex-col items-center text-center">
                  <div className="relative w-40 h-40 sm:w-48 sm:h-48 mb-5">
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-100 via-sky-100 to-transparent dark:from-indigo-500/10 dark:via-sky-500/10 dark:to-transparent rounded-full blur-2xl" />
                    <svg viewBox="0 0 200 200" className="relative w-full h-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <defs>
                        <linearGradient id="epPaper" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="#ffffff" />
                          <stop offset="100%" stopColor="#eef2ff" />
                        </linearGradient>
                        <linearGradient id="epBody" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="#6366f1" />
                          <stop offset="100%" stopColor="#4f46e5" />
                        </linearGradient>
                        <linearGradient id="epTop" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="#818cf8" />
                          <stop offset="100%" stopColor="#6366f1" />
                        </linearGradient>
                      </defs>
                      <ellipse cx="100" cy="172" rx="62" ry="8" fill="currentColor" className="text-gray-200 dark:text-gray-900/60" />
                      <rect x="52" y="46" width="96" height="46" rx="6" fill="url(#epPaper)" stroke="#c7d2fe" strokeWidth="1.5" />
                      <line x1="64" y1="60" x2="122" y2="60" stroke="#c7d2fe" strokeWidth="3" strokeLinecap="round" />
                      <line x1="64" y1="70" x2="112" y2="70" stroke="#dbeafe" strokeWidth="3" strokeLinecap="round" />
                      <line x1="64" y1="80" x2="100" y2="80" stroke="#dbeafe" strokeWidth="3" strokeLinecap="round" />
                      <rect x="42" y="86" width="116" height="56" rx="10" fill="url(#epBody)" />
                      <rect x="42" y="86" width="116" height="14" rx="10" fill="url(#epTop)" />
                      <rect x="58" y="118" width="84" height="34" rx="5" fill="url(#epPaper)" stroke="#c7d2fe" strokeWidth="1.5" />
                      <circle cx="138" cy="107" r="3" fill="#34d399" />
                      <circle cx="138" cy="107" r="6" fill="#34d399" opacity="0.25">
                        <animate attributeName="r" values="4;9;4" dur="2.4s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" />
                      </circle>
                      <circle cx="52" cy="107" r="2" fill="#f472b6" opacity="0.7" />
                      <path d="M76 132 h48" stroke="#c7d2fe" strokeWidth="2" strokeLinecap="round" />
                      <path d="M76 140 h32" stroke="#e0e7ff" strokeWidth="2" strokeLinecap="round" />
                      <g opacity="0.9">
                        <path d="M40 40 l4 -4 M40 40 l4 4 M40 40 l-4 4 M40 40 l-4 -4" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round">
                          <animateTransform attributeName="transform" type="rotate" from="0 40 40" to="360 40 40" dur="8s" repeatCount="indefinite" />
                        </path>
                        <path d="M164 58 l3 -3 M164 58 l3 3 M164 58 l-3 3 M164 58 l-3 -3" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round">
                          <animateTransform attributeName="transform" type="rotate" from="0 164 58" to="-360 164 58" dur="10s" repeatCount="indefinite" />
                        </path>
                        <circle cx="30" cy="120" r="2.5" fill="#f472b6" />
                        <circle cx="172" cy="130" r="2.5" fill="#34d399" />
                      </g>
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {isRtl ? "لا توجد طلبات طباعة بعد" : "No print jobs yet"}
                  </h3>
                  <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                    {isRtl
                      ? "الطابعة مرتاحة الآن. أول طلب يصل سيظهر هنا مباشرة."
                      : "Your printer is taking a breather. New jobs will land here the moment they arrive."}
                  </p>
                </div>
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <svg className="w-10 h-10 mx-auto mb-2 text-gray-300 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                <p>{isRtl ? "لا توجد نتائج" : "No results found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredGroups.map((group) => {
                  const isCollapsed = collapsedGroups.has(group.key);
                  const isExpanded = !isCollapsed;
                  const pendingCount = group.jobs.filter(
                    (j) => j.status === PrintStatus.PENDING || j.status === PrintStatus.READY,
                  ).length;
                  const allInGroupSelected = group.jobs.every((id) =>
                    selectedJobIds.has(id.id),
                  );
                  const printJobs = group.jobs.filter((j) => !j.fileType?.includes("word") && !j.fileType?.includes("document") && !j.fileType?.includes("excel") && !j.fileType?.includes("spreadsheet") && !j.fileType?.includes("presentation") && !j.fileType?.includes("powerpoint"));
                  const customerTotalData = currentSettings.pricing
                    ? calculateCustomerTotalWithDiscounts(
                        printJobs,
                        currentSettings,
                        jobPageCounts,
                        discountRules,
                      )
                    : null;
                  const customerTotal = customerTotalData?.finalTotal || 0;
                  const customerDiscount = customerTotalData?.totalDiscount || 0;

                  return (
                    <div
                      key={group.key}
                      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden mb-2 transition-all shadow-sm"
                    >
                      <div className="flex items-center border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 group/header">
                        <div className="px-4 py-2.5 flex items-center">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 dark:focus:ring-indigo-400 cursor-pointer"
                            checked={
                              allInGroupSelected && group.jobs.length > 0
                            }
                            onChange={(e) => toggleSelectGroup(group.jobs, e)}
                          />
                        </div>
                        <button
                          onClick={() => toggleGroup(group.key)}
                          className="flex-1 px-2 py-2.5 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                pendingCount > 0
                                  ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                                  : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
                              }`}
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                ></path>
                              </svg>
                            </div>
                            <div className="truncate text-left">
                              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">
                                {group.customerName ||
                                  (isRtl ? "بدون اسم" : "No Name")}
                              </h3>
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {group.phoneNumber ||
                                  (isRtl ? "بدون هاتف" : "No Phone")}
                                {" · "}
                                <span className="text-gray-400 dark:text-gray-500">{formatRelativeTime(group.latestDate, lang)}</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {customerTotal > 0 && (
                              <div className="flex flex-col items-end">
                                {customerDiscount > 0 && (
                                  <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
                                    {formatPrice(customerTotal + customerDiscount)}
                                  </span>
                                )}
                                <span className="text-sm font-bold text-green-700 dark:text-green-100 bg-green-100 dark:bg-green-900 px-3 py-1 rounded-full border border-green-200 dark:border-green-800 shadow-sm dark:shadow-gray-900/50 whitespace-nowrap">
                                  {formatPrice(customerTotal)}
                                </span>
                                {customerDiscount > 0 && (
                                  <span className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                                    {isRtl ? "تم توفير" : "Saved"} {formatPrice(customerDiscount)}
                                  </span>
                                )}
                              </div>
                            )}
                            <span
                              className={`px-3 py-1 text-xs font-bold rounded-full ${
                                pendingCount > 0
                                  ? "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-100"
                                  : "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100"
                              }`}
                            >
                              {group.jobs.length} {isRtl ? "ملف" : "files"}
                            </span>
                            <svg
                              className={`w-5 h-5 text-gray-400 dark:text-gray-500 transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M19 9l-7 7-7-7"
                              ></path>
                            </svg>
                          </div>
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse">
                            <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                              <tr>
                                <th className="px-4 py-2.5 w-10">
                                  <input
                                    type="checkbox"
                                    className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 dark:focus:ring-indigo-400 cursor-pointer"
                                    checked={
                                      allInGroupSelected &&
                                      group.jobs.length > 0
                                    }
                                    onChange={(e) =>
                                      toggleSelectGroup(group.jobs, e)
                                    }
                                  />
                                </th>
                                <th
                                  className={`px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}
                                >
                                  {t("fileName")}
                                </th>
                                <th
                                  className={`px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}
                                >
                                  {isRtl ? "الإعدادات" : "Settings"}
                                </th>
                                <th
                                  className={`px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}
                                >
                                  {isRtl ? "التكلفة" : "Cost"}
                                </th>
                                <th
                                  className={`px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}
                                >
                                  {t("status")}
                                </th>
                                <th
                                  className={`px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}
                                >
                                  {t("payment")}
                                </th>
                                <th className="px-4 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                  {t("actions")}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                              {group.jobs.map((job) => {
                                const isSelected = selectedJobIds.has(job.id);
                                const ext = getFileExtension(job.fileName);
                                const officeFile = isOfficeFile(job.fileType);

                                return (
                                  <tr
                                    key={job.id}
                                    className={`group/row transition-all duration-200 border-b border-gray-100 dark:border-white/10 ${
                                      isSelected
                                        ? "bg-indigo-50 dark:bg-indigo-900/20"
                                        : "hover:bg-gray-50 dark:hover:bg-gray-800"
                                    }`}
                                  >
                                    <td className="px-4 py-2 align-middle">
                                      <input
                                        type="checkbox"
                                        className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 dark:focus:ring-indigo-400 cursor-pointer"
                                        checked={isSelected}
                                        onChange={() => toggleSelectJob(job.id)}
                                      />
                                    </td>
                                    <td className="px-4 py-2 min-h-[80px]">
                                      <div className="flex items-center gap-3 w-full">
                                        <span
                                          className={`text-[10px] font-bold px-2 py-1 rounded-md border flex-shrink-0 ${
                                            ext === "PDF"
                                              ? "bg-red-50 dark:bg-red-900 text-red-600 dark:text-red-100 border-red-100 dark:border-red-800"
                                              : ext === "DOCX" || ext === "DOC"
                                                ? "bg-blue-50 dark:bg-blue-900 text-blue-600 dark:text-blue-100 border-blue-100 dark:border-blue-800"
                                                : officeFile
                                                  ? "bg-green-50 dark:bg-green-900 text-green-700 dark:text-green-100 border-green-200 dark:border-green-800"
                                                  : "bg-indigo-50 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-100 border-indigo-100 dark:border-indigo-800"
                                          }`}
                                        >
                                          {ext}
                                        </span>
                                        <div className="flex flex-col flex-1 min-w-0">
                                          <span className="flex items-center gap-1.5">
                                            <span
                                              className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"
                                              title={job.fileName}
                                            >
                                              {job.fileName}
                                            </span>
                                            {job.source === "gmail" && (
                                              <span className="text-[10px] font-semibold text-green-700 dark:text-green-100 bg-green-100 dark:bg-green-900 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 whitespace-nowrap shrink-0">
                                                Gmail
                                              </span>
                                            )}
                                          </span>
                                          <span className="text-xs text-gray-400 dark:text-gray-500">
                                            {formatSize(job.fileSize)}
                                          </span>
                                        </div>
                                      </div>
                                      {job.notes && (
                                        <div className="mt-2">
                                          {expandedNotes.has(job.id) || !job.id.startsWith("gmail_") ? (
                                            <div className="text-[11px] text-indigo-600 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 px-2 py-1 rounded-md inline-block font-medium max-w-xs break-words">
                                              {job.notes}
                                            </div>
                                          ) : (
                                            <>
                                              <div className="text-[11px] text-indigo-600 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 px-2 py-1 rounded-md inline-block font-medium max-w-xs break-words">
                                                {job.notes.length > 120 ? job.notes.slice(0, 120) + "..." : job.notes}
                                              </div>
                                              {job.notes.length > 120 && (
                                                <button type="button" onClick={() => toggleNoteExpand(job.id)} className="text-[10px] text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-400 dark:hover:text-indigo-300 ml-1 align-middle underline">
                                                  {isRtl ? "قراءة المزيد" : "Read more"}
                                                </button>
                                              )}
                                            </>
                                          )}
                                          {expandedNotes.has(job.id) && (
                                            <button onClick={() => toggleNoteExpand(job.id)} className="text-[10px] text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-400 dark:hover:text-indigo-300 ml-1 align-middle underline">
                                              {isRtl ? "طي" : "Less"}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </td>

                                    {/* Settings Cell (Color & Copies) */}
                                    <td className="px-4 py-2 align-top">
                                      {job.printPreferences && (
                                        <div className="flex flex-col gap-1 w-max">
                                          <div className="flex flex-wrap gap-1">
                                            <Button
                                              type="button"
                                              title={isRtl ? "انقر للتبديل" : "Toggle mode"}
                                              disabled={savingPrefsJobId === job.id}
                                              onClick={() => handleToggleColorMode(job)}
                                              variant={job.printPreferences.colorMode === "blackWhite" ? "secondary" : "default"}
                                              size="sm"
                                              className="text-xs h-7 px-2"
                                            >
                                              {savingPrefsJobId === job.id ? (
                                                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                              ) : (
                                                <>
                                                  <span className="text-[10px]">{job.printPreferences.colorMode === "blackWhite" ? "⚫" : "🎨"}</span>
                                                  {job.printPreferences.colorMode === "blackWhite" ? (isRtl ? "أبيض وأسود" : "B&W") : (isRtl ? "ملون" : "Color")}
                                                </>
                                              )}
                                            </Button>

                                            {/* Copies Stepper */}
                                            {editingCopiesJobId === job.id ? (
                                              <div className="flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-0.5 shadow-sm dark:shadow-gray-900/50 w-max">
                                                <Button
                                                  type="button"
                                                  variant="ghost"
                                                  size="icon"
                                                  className="w-6 h-6"
                                                  onMouseDown={(e) => e.preventDefault()}
                                                  onClick={() => setEditingCopiesValue((v) => Math.max(1, v - 1))}
                                                >−</Button>
                                                <Input
                                                  type="number"
                                                  min={1}
                                                  max={100}
                                                  autoFocus
                                                  value={editingCopiesValue}
                                                  onChange={(e) => setEditingCopiesValue(parseInt(e.target.value) || 1)}
                                                  onKeyDown={(e) => {
                                                    if (e.key === "Enter") handleSaveCopies(job, editingCopiesValue);
                                                    if (e.key === "Escape") setEditingCopiesJobId(null);
                                                  }}
                                                  onBlur={() => handleSaveCopies(job, editingCopiesValue)}
                                                  className="w-10 text-center text-xs font-semibold h-7 px-0"
                                                />
                                                <Button
                                                  type="button"
                                                  variant="ghost"
                                                  size="icon"
                                                  className="w-6 h-6"
                                                  onMouseDown={(e) => e.preventDefault()}
                                                  onClick={() => setEditingCopiesValue((v) => Math.min(100, v + 1))}
                                                >+</Button>
                                                <Button
                                                  type="button"
                                                  size="icon"
                                                  className="w-6 h-6 ml-1"
                                                  onMouseDown={(e) => e.preventDefault()}
                                                  onClick={() => handleSaveCopies(job, editingCopiesValue)}
                                                >
                                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>
                                                </Button>
                                              </div>
                                            ) : (
                                              <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="text-xs h-7 px-2"
                                                onClick={() => {
                                                  setEditingCopiesJobId(job.id);
                                                  setEditingCopiesValue(job.printPreferences?.copies || 1);
                                                }}
                                              >
                                                ×{job.printPreferences?.copies || 1} {isRtl ? "نسخ" : "copies"}
                                              </Button>
                                            )}

                                            {/* Paper Type Select */}
                                            <Select
                                              value={job.printPreferences?.paperType || "normal"}
                                              onValueChange={(val) => handlePaperTypeChange(job, val)}
                                            >
                                              <SelectTrigger disabled={savingPrefsJobId === job.id} className="h-7 text-xs px-2 py-0 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900 text-amber-700 dark:text-amber-100 rounded-lg font-medium w-auto gap-1 focus:ring-amber-500 dark:focus:ring-amber-400">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {paperTypes.map(pt => (
                                                  <SelectItem key={pt.id} value={pt.id}>
                                                    {isRtl ? pt.nameAr : pt.name}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                        </div>
                                      )}
                                    </td>

                                    {/* Cost Cell */}
                                    <td className="px-4 py-2 align-middle whitespace-nowrap">
                                      {(currentSettings.pricing || (currentSettings.paperTypes && currentSettings.paperTypes.length > 0)) ? (
                                        (() => {
                                          const isOffice = job.fileType?.includes("word") || job.fileType?.includes("document") || job.fileType?.includes("excel") || job.fileType?.includes("spreadsheet") || job.fileType?.includes("presentation") || job.fileType?.includes("powerpoint");
                                          if (isOffice) return <span className="text-xs text-gray-400 dark:text-gray-500">-</span>;
                                          const pageCount = jobPageCounts[job.id] || 1;
                                          const priceCalc = calculatePrintPrice(job, currentSettings, pageCount);
                                          const discountResult = calculateJobDiscount(job, priceCalc.totalPrice, priceCalc.totalPages, discountRules);
                                          const hasDiscount = discountResult.discountAmount > 0;

                                          return (
                                            <div className="flex flex-col gap-1">
                                              <div className="flex flex-col">
                                                {hasDiscount && (
                                                  <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
                                                    {formatPrice(discountResult.originalAmount)}
                                                  </span>
                                                )}
                                                <span className={`text-sm font-black bg-green-100 dark:bg-[#173404] px-2.5 py-1 rounded-md border border-green-200 dark:border-green-800 shadow-sm dark:shadow-gray-900/50 w-max inline-block tracking-tight ${hasDiscount ? "text-green-700 dark:text-[#C0DD97]" : "text-green-700 dark:text-[#C0DD97]"}`}>
                                                  {formatPrice(discountResult.finalAmount)}
                                                </span>
                                                {hasDiscount && discountResult.rule && (
                                                  <span className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                                                    {isRtl ? "تم تطبيق خصم" : "Discount applied"}: {discountResult.rule.name}
                                                  </span>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 font-medium">
                                                <span>
                                                  {isRtl ? "الصفحات:" : "Pages:"}
                                                </span>
                                                <span className="font-bold text-indigo-700 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 border border-indigo-100 dark:border-indigo-800 px-2 py-0.5 rounded text-[11px]">
                                                  {pageCount}
                                                </span>
                                              </div>
                                            </div>
                                          );
                                        })()
                                      ) : (
                                        <span className="text-xs text-gray-400 dark:text-gray-500">
                                          -
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      <span
                                        className={`px-3 py-1 text-[11px] font-bold rounded-full uppercase tracking-wide inline-block ${
                                          job.status === PrintStatus.PRINTED
                                            ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 border border-green-200 dark:border-green-800"
                                            : job.status === PrintStatus.READY
                                            ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-100 border border-blue-200 dark:border-blue-800"
                                            : "bg-amber-100 dark:bg-[#412402] text-amber-700 dark:text-[#FAC775] border border-amber-200 dark:border-amber-800"
                                        }`}
                                      >
                                        {job.status === PrintStatus.PRINTED
                                          ? t("printed")
                                          : job.status === PrintStatus.READY
                                          ? t("ready")
                                          : t("pending")}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      <span
                                        className={`px-2 py-1 text-[11px] font-bold rounded-full inline-flex items-center gap-1 cursor-pointer hover:opacity-80 ${
                                          job.paymentStatus === PaymentStatus.PAID
                                            ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 border border-green-200 dark:border-green-800"
                                            : job.paymentStatus === PaymentStatus.PARTIAL
                                            ? "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-100 border border-amber-200 dark:border-amber-800"
                                            : "bg-red-100 dark:bg-[#501313] text-red-700 dark:text-[#F7C1C1] border border-red-200 dark:border-red-800"
                                        }`}
                                        onClick={() => handlePaymentClick(job)}
                                        title={isRtl ? "انقر لتعديل الدفع" : "Click to edit payment"}
                                      >
                                        <span className="text-[10px]">
                                          {job.paymentStatus === PaymentStatus.PAID ? "✓" : job.paymentStatus === PaymentStatus.PARTIAL ? "◐" : "✕"}
                                        </span>
                                        <span>
                                          {job.paymentStatus === PaymentStatus.PAID
                                            ? t("paid")
                                            : job.paymentStatus === PaymentStatus.PARTIAL
                                            ? t("partial")
                                            : t("unpaid")}
                                        </span>
                                        {job.paymentAmount ? (
                                          <span className="text-[10px] opacity-70 font-mono">{formatPrice(job.paymentAmount)}</span>
                                        ) : null}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      <div className="flex items-center gap-0.5 w-max">
                                        {officeFile ? (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleOpenInApp(job)}
                                            title={isRtl ? "فتح في التطبيق" : "Open in default app"}
                                            className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
                                          >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                                          </Button>
                                        ) : (
                                          <>
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              onClick={() => handleQuickPrint(job)}
                                              title={isRtl ? `طباعة سريعة${defaultPrinterName ? ` — ${defaultPrinterName}` : ""}` : `Quick Print${defaultPrinterName ? ` — ${defaultPrinterName}` : ""}`}
                                              className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
                                            >
                                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                                            </Button>
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              onClick={() => handlePrintOptions(job)}
                                              title={isRtl ? "خيارات الطباعة" : "Print options"}
                                              className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
                                            >
                                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                                            </Button>
                                          </>
                                        )}
                                        <Button variant="ghost" size="icon" onClick={() => handlePreview(job)} title={isRtl ? "معاينة" : "Preview"} className="text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-white/10 w-8 h-8">
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => handleEdit(job)} title={t("edit")} className="text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-white/10 w-8 h-8">
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => handleDownload(job)} title={t("download")} className="text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-white/10 w-8 h-8">
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                        </Button>
                                        <span className="mx-1 w-px h-6 bg-gray-200 dark:bg-white/20 shrink-0" />
                                        <span className="group/status relative" title={isRtl ? "تغيير الحالة" : "Change status"}>
                                          <Select value={job.status} onValueChange={(val) => handleStatusChange(job.id, val as PrintStatus)}>
                                            <SelectTrigger className={`h-8 w-8 border-0 p-0 ${job.status === PrintStatus.PRINTED ? "text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-white/10" : job.status === PrintStatus.READY ? "text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10" : "text-yellow-600 dark:text-yellow-400 hover:bg-yellow-100 dark:hover:bg-white/10"}`}>
                                              <SelectValue>
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                              </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem value={PrintStatus.PENDING}>
                                                <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-yellow-500 dark:bg-yellow-400 inline-block"></span>{isRtl ? "قيد الانتظار" : "Pending"}</span>
                                              </SelectItem>
                                              <SelectItem value={PrintStatus.READY}>
                                                <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span>{isRtl ? "جاهز" : "Ready"}</span>
                                              </SelectItem>
                                              <SelectItem value={PrintStatus.PRINTED}>
                                                <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>{isRtl ? "تمت الطباعة" : "Printed"}</span>
                                              </SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </span>
                                        <Button variant="ghost" size="icon" onClick={() => handleDelete(job.id)} title={t("delete")} className="text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-white/10 w-8 h-8">
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                        </Button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </>
            );
            })()}
          </>
        ) : activeTab === "review" ? (
          <ReviewQueuePanel reviewJobs={reviewJobs} onRefresh={loadJobs} onPreview={handlePreview} />
        ) : activeTab === "gmail" ? (
          <GmailPanel paperTypes={paperTypes} onJobsImported={loadJobs} />
        ) : activeTab === "inventory" ? (
          <InventorySection
            lang={lang}
            paperTypes={paperTypes}
            onLowStockCountChange={setLowStockCount}
          />
        ) : (
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
                    {isRtl ? "رابط السحابة" : "Cloud URL"}
                  </label>
                  <Input value={cloudSyncUrl} onChange={(e) => setCloudSyncUrl(e.target.value)} placeholder="https://your-cloud-app.com" />
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
              </CardContent>
            </Card>

            {/* QR Poster Card */}
            <Card className="lg:col-span-2 border-0">
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
                      onClick={() => setActiveTab("inventory")}
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
                  {groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.PENDING).length, 0)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "جاهز للاستلام" : "Ready Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.READY).length, 0)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "الملفات المطبوعة" : "Printed Files"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-green-600 dark:text-green-400">
                  {groups.reduce((acc, g) => acc + g.jobs.filter(j => j.status === PrintStatus.PRINTED).length, 0)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm dark:shadow-gray-900/50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {isRtl ? "إجمالي العملاء" : "Total Customers"}
                </div>
                <div className="text-xl sm:text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                  {groups.length}
                </div>
              </div>
            </div>

            {/* Save Button */}
            <div className="sticky bottom-0 bg-white dark:bg-gray-800 z-10 -mx-2 px-4 pb-4 pt-3 mt-6 sm:mt-8 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 rounded-2xl shadow-md dark:shadow-gray-900/30">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {isRtl
                  ? "سيتم حفظ التغييرات فورًا"
                  : "Changes will be saved immediately"}
              </p>
              <Button onClick={saveSettings} className="shadow-lg">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                {t("saveSettings")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <QrPosterDialog
        open={qrPosterOpen}
        onOpenChange={setQrPosterOpen}
        lang={lang}
        shopSettings={currentSettings}
        allowPrint
      />

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "حذف متعدد" : "Bulk Delete"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl ? `هل أنت متأكد من حذف ${selectedJobIds.size} ملف؟` : `Are you sure you want to delete ${selectedJobIds.size} files?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmBulkDelete} className="bg-destructive text-destructive-foreground dark:text-destructive-foreground hover:bg-destructive/90 dark:hover:bg-destructive/70">{isRtl ? "حذف" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Payment Edit Dialog */}
      <Dialog open={paymentEditJob !== null} onOpenChange={(open) => { if (!open) setPaymentEditJob(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRtl ? "تعديل حالة الدفع" : "Edit Payment Status"}</DialogTitle>
            <DialogDescription>
              {paymentEditJob?.fileName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {[PaymentStatus.PAID, PaymentStatus.PARTIAL, PaymentStatus.UNPAID].map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant={paymentEditStatus === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPaymentEditStatus(s)}
                  className={paymentEditStatus === s ? (
                    s === PaymentStatus.PAID ? "bg-green-600 dark:bg-green-500" : s === PaymentStatus.PARTIAL ? "bg-amber-600 dark:bg-amber-500" : "bg-red-600 dark:bg-red-500"
                  ) : ""}
                >
                  {s === PaymentStatus.PAID ? t("paid") : s === PaymentStatus.PARTIAL ? t("partial") : t("unpaid")}
                </Button>
              ))}
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t("paymentAmount")} (DZD)</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={paymentEditAmount}
                onChange={(e) => setPaymentEditAmount(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentEditJob(null)}>{t("cancel")}</Button>
            <Button onClick={handleSavePayment}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single Delete Confirmation */}
      <AlertDialog open={singleDeleteConfirm !== null} onOpenChange={(open) => { if (!open) setSingleDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "تأكيد الحذف" : "Confirm Delete"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl ? "هل أنت متأكد من حذف هذا الملف؟" : "Are you sure you want to delete this file?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSingleDelete} className="bg-destructive text-destructive-foreground dark:text-destructive-foreground hover:bg-destructive/90 dark:hover:bg-destructive/70">{isRtl ? "حذف" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {/* Toaster */}
      <Toaster />

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

      <PreviewModal
        open={previewJob !== null}
        onClose={() => { setPreviewJob(null); setPreviewUrl(null); }}
        url={previewUrl}
        fileName={previewJob?.fileName ?? ""}
        fileType={previewJob?.fileType}
        fileSize={previewJob?.fileSize}
      />

          </div>
        </div>
      </div>
    </div>
  );
};

const AdminView: React.FC<AdminViewProps> = (props) => (
  <AdminProvider
    lang={props.lang}
    darkMode={props.darkMode ?? false}
    themeMode={props.themeMode ?? "system"}
    onToggleDarkMode={props.onToggleDarkMode}
    onToggleLang={props.onToggleLang}
    settings={props.currentSettings}
    onSettingsUpdate={props.onSettingsUpdate}
  >
    <AdminViewInner {...props} />
  </AdminProvider>
);

export default AdminView;
