import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrintJob, PrintStatus, PaymentStatus, ShopSettings, PrinterJobDefaults } from "../../../types";
import { storageService } from "../../../services/storageService";
import { isElectron, printFile } from "../../../lib/electronPrint";
import { getActualPageCount } from "../../../utils/pricingUtils";
import { toast } from "../../../components/ui/use-toast";

export interface CustomerGroup {
  key: string;
  customerName: string;
  phoneNumber: string;
  jobs: PrintJob[];
  latestDate: string;
}

export const isOfficeFile = (fileType: string | null | undefined) => {
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

type PrintOutcome = "ok" | "cancelled" | "error" | "unsupported";

interface UseAdminJobsOptions {
  currentSettings: ShopSettings;
  /** Called after a job is marked printed so the inventory badge can refresh. */
  onLowStockRefresh: () => void;
}

/**
 * Owns everything about the job list: fetch + grouping, the SSE subscription,
 * selection, per-row preference edits (optimistic), bulk actions, and native
 * printing. AdminView calls this once and threads the result into JobsPanel;
 * it also reads `reviewJobs` for the sidebar badge and `loadJobs` for the
 * other panels' refresh hooks.
 */
export function useAdminJobs({ currentSettings, onLowStockRefresh }: UseAdminJobsOptions) {
  const navigate = useNavigate();

  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewJobs, setReviewJobs] = useState<PrintJob[]>([]);
  const [jobPageCounts, setJobPageCounts] = useState<{ [jobId: string]: number }>({});
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [editingCopiesJobId, setEditingCopiesJobId] = useState<string | null>(null);
  const [editingCopiesValue, setEditingCopiesValue] = useState<number>(1);
  const [savingPrefsJobId, setSavingPrefsJobId] = useState<string | null>(null);
  const [bulkPrinting, setBulkPrinting] = useState(false);
  const [editingJob, setEditingJob] = useState<PrintJob | null>(null);
  const [editingBlob, setEditingBlob] = useState<Blob | null>(null);
  const [paymentEditJob, setPaymentEditJob] = useState<PrintJob | null>(null);
  const [paymentEditStatus, setPaymentEditStatus] = useState<string>(PaymentStatus.UNPAID);
  const [paymentEditAmount, setPaymentEditAmount] = useState<number>(0);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [singleDeleteConfirm, setSingleDeleteConfirm] = useState<string | null>(null);

  // Locale for toast copy. Read from storage so a mid-session switch is honoured.
  const rtl =
    typeof localStorage !== "undefined" && localStorage.getItem("ps_language") === "ar";

  const defaultPrinterName = currentSettings.defaultPrinterName || "";
  const printerDefaults: Record<string, PrinterJobDefaults> = currentSettings.printerDefaults || {};

  const countPagesForAllJobs = useCallback(async (grps: CustomerGroup[]) => {
    const pageCounts: { [jobId: string]: number } = {};
    for (const group of grps) {
      for (const job of group.jobs) {
        if (job.pageCount && job.pageCount > 0) pageCounts[job.id] = job.pageCount;
      }
    }
    for (const group of grps) {
      for (const job of group.jobs) {
        if (pageCounts[job.id]) continue;
        try {
          const url = await storageService.getFileUrl(job.id);
          if (url) {
            const response = await fetch(url);
            const blob = await response.blob();
            const file = new File([blob], job.fileName, { type: job.fileType });
            pageCounts[job.id] = await getActualPageCount(file);
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
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    const allData = await storageService.getMetadata();
    const data = allData.filter((j) => (j.status as string) !== "pending_review");
    setReviewJobs(allData.filter((j) => (j.status as string) === "pending_review"));
    const grouped = data.reduce((acc: { [key: string]: CustomerGroup }, job) => {
      const name = job.customerName?.trim() || "";
      const phone = job.phoneNumber?.trim() || "";
      let key = `${name}-${phone}`;
      if (!name && !phone) {
        const timeKey = new Date(job.uploadDate).toISOString().slice(0, 16);
        key = `anon-${timeKey}`;
      }
      if (!acc[key]) {
        acc[key] = { key, customerName: name, phoneNumber: phone, jobs: [], latestDate: job.uploadDate };
      }
      acc[key].jobs.push(job);
      if (new Date(job.uploadDate) > new Date(acc[key].latestDate)) acc[key].latestDate = job.uploadDate;
      return acc;
    }, {});
    const sortedGroups = Object.values(grouped).sort(
      (a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime(),
    );
    sortedGroups.forEach((group) => {
      group.jobs.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime());
    });
    setGroups(sortedGroups);
    setLoading(false);
    countPagesForAllJobs(sortedGroups);
  }, [countPagesForAllJobs]);

  const loadJobsRef = useRef(loadJobs);
  loadJobsRef.current = loadJobs;

  useEffect(() => {
    loadJobsRef.current();
    const es = new EventSource("/api/events");
    es.addEventListener("new-job", () => loadJobsRef.current());
    es.addEventListener("cloud-job-imported", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        const label = data.customerName ? `${data.customerName} — ${data.fileName}` : data.fileName;
        toast({ title: rtl ? `طلب جديد من الرفع الإلكتروني: ${label}` : `New online upload: ${label}`, variant: "success" });
        new Audio("/notification.mp3").play().catch(() => {});
      } catch {}
      loadJobsRef.current();
    });
    es.addEventListener("job-deleted", () => loadJobsRef.current());
    es.onerror = () => {};
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectJob = (id: string) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectGroup = (jobs: PrintJob[], _e?: unknown) => {
    const jobIds = jobs.map((j) => j.id);
    setSelectedJobIds((prev) => {
      const allSelected = jobIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) jobIds.forEach((id) => next.delete(id));
      else jobIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleNoteExpand = (id: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  const defaultsForActivePrinter = (): PrinterJobDefaults | null => {
    if (!defaultPrinterName) return null;
    return printerDefaults[defaultPrinterName] || null;
  };

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
        title: rtl ? "الطباعة الأصلية غير متوفرة" : "Native printing unavailable",
        description: rtl ? "افتح التطبيق من سطح المكتب للطباعة." : "Open the desktop app to print.",
        variant: "destructive",
      });
      return "unsupported";
    }

    const filePath = await storageService.getFileLocalPath(job.id);
    if (!filePath) {
      maybeToast({
        title: rtl ? "تعذر تحديد مسار الملف" : "Could not resolve file path",
        description: job.fileName,
        variant: "destructive",
      });
      return "error";
    }

    if (mode === "open") {
      try {
        const result = await printFile({ filePath, fileType: job.fileType });
        if (result.ok) {
          maybeToast({
            title: rtl ? "تم فتح الملف في التطبيق الافتراضي" : "Opened in default app",
            description: job.fileName,
            variant: "success",
          });
          return "ok";
        }
        return "error";
      } catch (err) {
        maybeToast({
          title: rtl ? "تعذر فتح الملف" : "Failed to open file",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
        return "error";
      }
    }

    if (mode === "quick" && !defaultPrinterName) {
      maybeToast({
        title: rtl ? "لم يتم تعيين طابعة افتراضية" : "No default printer set",
        description: rtl ? "اختر طابعة افتراضية من الإعدادات." : "Pick a default printer in Settings.",
        variant: "destructive",
      });
      return "unsupported";
    }

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
        printerName: mode === "quick" ? defaultPrinterName : defaultPrinterName || "",
        silent: mode === "quick",
        options,
      });
      if (result.cancelled) {
        maybeToast({ title: rtl ? "تم إلغاء الطباعة" : "Print cancelled" });
        return "cancelled";
      }
      if (result.ok) {
        maybeToast({
          title: mode === "quick" ? (rtl ? "تم إرسال المهمة" : "Sent to printer") : rtl ? "تم إرسال المهمة" : "Print job submitted",
          description: job.fileName,
          variant: "success",
        });
        return "ok";
      }
      return "error";
    } catch (err) {
      maybeToast({
        title: rtl ? "فشل الطباعة" : "Print failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      return "error";
    }
  };

  const handleQuickPrint = (job: PrintJob) => printJobViaIpc(job, "quick");
  const handlePrintOptions = (job: PrintJob) => printJobViaIpc(job, "options");
  const handleOpenInApp = (job: PrintJob) => printJobViaIpc(job, "open");

  const handleBulkPrint = async () => {
    const selectedJobs = groups.flatMap((g) => g.jobs).filter((j) => selectedJobIds.has(j.id));
    if (selectedJobs.length === 0 || bulkPrinting) return;
    setBulkPrinting(true);
    let sent = 0;
    let failed = 0;
    const failedNames: string[] = [];
    let cancelled = false;
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
          toast({
            title: rtl ? "الطباعة السريعة غير متاحة" : "Quick Print unavailable",
            description: rtl ? "اختر طابعة افتراضية من الإعدادات." : "Set a default printer in Settings, then try again.",
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
        if (i < selectedJobs.length - 1) await new Promise((r) => setTimeout(r, INTER_JOB_MS));
      }
    } finally {
      setBulkPrinting(false);
    }
    if (cancelled) {
      toast({
        title: rtl ? "تم إيقاف الطباعة الجماعية" : "Bulk print stopped",
        description: rtl ? `أُرسل ${sent} من ${selectedJobs.length} قبل الإلغاء.` : `Sent ${sent} of ${selectedJobs.length} before cancel.`,
      });
    } else if (failed === 0) {
      toast({ title: rtl ? `تم إرسال ${sent} مهمة` : `Sent ${sent} job${sent === 1 ? "" : "s"}`, variant: "success" });
    } else {
      toast({
        title: rtl ? `أُرسل ${sent}، فشل ${failed}` : `${sent} sent, ${failed} failed`,
        description: failedNames.slice(0, 3).join(", ") + (failedNames.length > 3 ? "…" : ""),
        variant: "destructive",
      });
    }
  };

  const handleBulkDownload = async () => {
    const selectedIds = Array.from(selectedJobIds);
    for (let i = 0; i < selectedIds.length; i++) {
      const job = groups.flatMap((g) => g.jobs).find((j) => j.id === selectedIds[i]);
      if (job) {
        await handleDownload(job);
        if (selectedIds.length > 1) await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  const handleBulkDelete = () => setBulkDeleteConfirm(true);

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkDeleteJobs(ids);
      setSelectedJobIds(new Set());
      setBulkDeleteConfirm(false);
      loadJobs();
      toast({ title: rtl ? `تم حذف ${ids.length} ملفات` : `${ids.length} files deleted successfully`, variant: "success" });
    } catch (err) {
      toast({ title: rtl ? "فشل الحذف" : "Delete failed", variant: "destructive" });
    }
  };

  const handleBulkStatusUpdate = async (status: PrintStatus = PrintStatus.PRINTED) => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkUpdateStatus(ids, status);
      setSelectedJobIds(new Set());
      loadJobs();
      if (status === PrintStatus.PRINTED) onLowStockRefresh();
      toast({ title: rtl ? `تم تحديث ${ids.length} ملفات` : `${ids.length} files updated`, variant: "success" });
    } catch (err) {
      toast({ title: rtl ? "فشل التحديث" : "Update failed", variant: "destructive" });
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
        toast({ title: rtl ? "تحرير الصور متاح لملفات الصور فقط." : "Editing is only for image files.", variant: "destructive" });
      }
    }
  };

  const handleSaveEditedImage = async (newBlob: Blob) => {
    if (editingJob) {
      try {
        const file = new File([newBlob], editingJob.fileName, { type: newBlob.type });
        await storageService.updateJobFile(editingJob.id, file);
        setEditingJob(null);
        setEditingBlob(null);
        loadJobs();
        toast({ title: rtl ? "تم تحديث الملف بنجاح" : "File updated successfully", variant: "success" });
      } catch (err) {
        console.error("Failed to update job file:", err);
        toast({ title: rtl ? "فشل تحديث الملف." : "Failed to update file.", variant: "destructive" });
      }
    }
  };

  const handleStatusChange = async (jobId: string, newStatus: PrintStatus) => {
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
      if (newStatus === PrintStatus.PRINTED) onLowStockRefresh();
    } catch (err) {
      if (previousStatus !== undefined) {
        const rollbackTo = previousStatus;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            jobs: g.jobs.map((j) => (j.id === jobId ? { ...j, status: rollbackTo } : j)),
          })),
        );
      }
      toast({ title: rtl ? "فشل تحديث الحالة" : "Failed to update status", variant: "destructive" });
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
      toast({ title: rtl ? "تم تحديث حالة الدفع" : "Payment status updated", variant: "success" });
    } catch (err) {
      toast({ title: rtl ? "فشل تحديث الدفع" : "Failed to update payment", variant: "destructive" });
    }
  };

  const handleBulkPaymentStatus = async (status: string) => {
    const ids = Array.from(selectedJobIds);
    try {
      await storageService.bulkUpdatePayment(ids, status);
      setSelectedJobIds(new Set());
      loadJobs();
      toast({ title: `${ids.length} ${rtl ? "تم تحديث الدفع" : "payment(s) updated"}`, variant: "success" });
    } catch (err) {
      toast({ title: rtl ? "فشل" : "Failed", variant: "destructive" });
    }
  };

  const handleDelete = (id: string) => setSingleDeleteConfirm(id);

  const confirmSingleDelete = async () => {
    if (singleDeleteConfirm) {
      await storageService.deleteJob(singleDeleteConfirm);
      setSelectedJobIds((prev) => {
        const next = new Set(prev);
        next.delete(singleDeleteConfirm);
        return next;
      });
      setSingleDeleteConfirm(null);
      loadJobs();
      toast({ title: rtl ? "تم الحذف بنجاح" : "Deleted successfully", variant: "success" });
    }
  };

  const patchJobPrefs = (
    jobId: string,
    prefs: { colorMode: string; copies: number; paperType: string },
  ) => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        jobs: g.jobs.map((j) =>
          j.id === jobId
            ? { ...j, printPreferences: prefs as NonNullable<PrintJob["printPreferences"]> }
            : j,
        ),
      })),
    );
  };

  const handlePaperTypeChange = async (job: PrintJob, newPaperType: string) => {
    if (savingPrefsJobId === job.id) return;
    const colorMode = job.printPreferences?.colorMode || "color";
    const copies = job.printPreferences?.copies || 1;
    setSavingPrefsJobId(job.id);
    try {
      await storageService.updateJobPreferences(job.id, { colorMode, copies, paperType: newPaperType });
      patchJobPrefs(job.id, { colorMode, copies, paperType: newPaperType });
    } catch (err) {
      console.error("Failed to update paper type", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  const handleToggleColorMode = async (job: PrintJob) => {
    if (savingPrefsJobId === job.id) return;
    const newMode = job.printPreferences?.colorMode === "blackWhite" ? "color" : "blackWhite";
    const newCopies = job.printPreferences?.copies || 1;
    const paperType = job.printPreferences?.paperType || "normal";
    setSavingPrefsJobId(job.id);
    try {
      await storageService.updateJobPreferences(job.id, { colorMode: newMode, copies: newCopies, paperType });
      patchJobPrefs(job.id, { colorMode: newMode, copies: newCopies, paperType });
    } catch (err) {
      console.error("Failed to update color mode", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  const handleSaveCopies = async (job: PrintJob, copies: number) => {
    if (savingPrefsJobId === job.id) return;
    const safeCopies = Math.max(1, Math.min(100, copies));
    const colorMode = job.printPreferences?.colorMode || "color";
    const paperType = job.printPreferences?.paperType || "normal";
    setSavingPrefsJobId(job.id);
    setEditingCopiesJobId(null);
    try {
      await storageService.updateJobPreferences(job.id, { colorMode, copies: safeCopies, paperType });
      patchJobPrefs(job.id, { colorMode, copies: safeCopies, paperType });
    } catch (err) {
      console.error("Failed to update copies", err);
    } finally {
      setSavingPrefsJobId(null);
    }
  };

  return {
    groups,
    loading,
    reviewJobs,
    jobPageCounts,
    selectedJobIds,
    setSelectedJobIds,
    collapsedGroups,
    expandedNotes,
    editingCopiesJobId,
    setEditingCopiesJobId,
    editingCopiesValue,
    setEditingCopiesValue,
    savingPrefsJobId,
    bulkPrinting,
    editingJob,
    setEditingJob,
    editingBlob,
    setEditingBlob,
    paymentEditJob,
    setPaymentEditJob,
    paymentEditStatus,
    setPaymentEditStatus,
    paymentEditAmount,
    setPaymentEditAmount,
    bulkDeleteConfirm,
    setBulkDeleteConfirm,
    singleDeleteConfirm,
    setSingleDeleteConfirm,
    loadJobs,
    toggleGroup,
    toggleSelectJob,
    toggleSelectGroup,
    toggleNoteExpand,
    handleDownload,
    handleQuickPrint,
    handlePrintOptions,
    handleOpenInApp,
    handleBulkPrint,
    handleBulkDownload,
    handleBulkDelete,
    confirmBulkDelete,
    handleBulkStatusUpdate,
    handleBulkPaymentStatus,
    handleEdit,
    handleSaveEditedImage,
    handleStatusChange,
    handlePaymentClick,
    handleSavePayment,
    handleDelete,
    confirmSingleDelete,
    handlePaperTypeChange,
    handleToggleColorMode,
    handleSaveCopies,
  };
}

export type AdminJobsApi = ReturnType<typeof useAdminJobs>;
