import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrintJob, PrintStatus, PaymentStatus, ShopSettings, PrinterJobDefaults } from "../../../types";
import { storageService } from "../../../services/storageService";
import { isElectron, printFile, getPrinters, PrinterInfo } from "../../../lib/electronPrint";
import { toast } from "../../../components/ui/use-toast";
import { openAdminEventSource } from "../../../utils/adminEvents";
import { readPref } from "@localprint/shared/lib/prefs";

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

export interface StudioPrintOptions {
  printerName: string;
  copies: number;
  color: boolean;
  duplexMode: "simplex" | "longEdge" | "shortEdge";
  collate: boolean;
  landscape: boolean;
  pageSize: string;
  pageRanges: string;
}

/** "1-3, 5, 8-10" -> [{from:0,to:2},{from:4,to:4},{from:7,to:9}] (0-indexed). */
function parsePageRanges(spec: string): { from: number; to: number }[] {
  if (!spec || !spec.trim()) return [];
  const out: { from: number; to: number }[] = [];
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const from = parseInt(m[1], 10) - 1;
    const to = (m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10)) - 1;
    if (from >= 0 && to >= from) out.push({ from, to });
  }
  return out;
}

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
  // True while a refresh is in flight over data that is already on screen —
  // drives a thin progress hint instead of blowing the list away.
  const [refreshing, setRefreshing] = useState(false);
  const hasDataRef = useRef(false);
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
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printOptionsJob, setPrintOptionsJob] = useState<PrintJob | null>(null);
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(new Set());
  // How many rows the server was asked for, and how many exist in total. The
  // list loads the newest page and only pulls older jobs when asked.
  const [jobLimit, setJobLimit] = useState<number | undefined>(undefined);
  const [totalJobCount, setTotalJobCount] = useState(0);
  // Read through a ref so SSE-driven refreshes always use the current page
  // size without re-subscribing the event source.
  const jobLimitRef = useRef(jobLimit);
  jobLimitRef.current = jobLimit;

  // Job ids present at the last load, so a soft refresh can highlight only the
  // rows that are genuinely new. Timers clear each highlight after a short beat.
  const prevJobIdsRef = useRef<Set<string>>(new Set());
  const highlightTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const markRecentlyChanged = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setRecentlyChanged((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    ids.forEach((id) => {
      if (highlightTimersRef.current[id]) clearTimeout(highlightTimersRef.current[id]);
      highlightTimersRef.current[id] = setTimeout(() => {
        setRecentlyChanged((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        delete highlightTimersRef.current[id];
      }, 2500);
    });
  }, []);

  // Remove a single job in place (SSE job-deleted) without a full refetch,
  // dropping the customer group once its last job is gone.
  const removeJobById = useCallback((id: string) => {
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, jobs: g.jobs.filter((j) => j.id !== id) }))
        .filter((g) => g.jobs.length > 0),
    );
    setReviewJobs((prev) => prev.filter((j) => j.id !== id));
    prevJobIdsRef.current.delete(id);
  }, []);

  const loadPrinters = useCallback(async () => {
    if (!isElectron()) return;
    try {
      setPrinters(await getPrinters());
    } catch (err) {
      console.error("Failed to enumerate printers:", err);
    }
  }, []);

  // Locale for toast copy. Read from storage so a mid-session switch is honoured.
  const rtl =
    typeof localStorage !== "undefined" && readPref("language") === "ar";

  const defaultPrinterName = currentSettings.defaultPrinterName || "";
  const printerDefaults: Record<string, PrinterJobDefaults> = currentSettings.printerDefaults || {};

  // The server computes and stores pageCount for every upload (and backfills
  // older rows at startup), so the list just reads it. This used to download
  // and parse every job file in a serial loop on each refresh — that was the
  // single biggest reason the dashboard felt frozen on a busy shop.
  const collectPageCounts = useCallback((grps: CustomerGroup[]) => {
    const pageCounts: { [jobId: string]: number } = {};
    for (const group of grps) {
      for (const job of group.jobs) {
        pageCounts[job.id] = job.pageCount && job.pageCount > 0 ? job.pageCount : 1;
      }
    }
    setJobPageCounts(pageCounts);
  }, []);

  const loadJobs = useCallback(async (opts?: { soft?: boolean }) => {
    const soft = opts?.soft === true;
    // The skeleton is only for a genuinely empty list. Once rows are on screen,
    // any refresh — SSE or an explicit one from another panel — keeps the
    // current data visible so the list never flashes or scroll-jumps.
    const showSkeleton = !soft && !hasDataRef.current;
    if (showSkeleton) setLoading(true);
    else setRefreshing(true);
    try {
    const { jobs: allData, total } = await storageService.getJobsPage({ limit: jobLimitRef.current });
    setTotalJobCount(total);
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
    // On a soft refresh, highlight rows that weren't in the previous snapshot.
    const nextIds = new Set(data.map((j) => j.id));
    if (soft) {
      const added = data.filter((j) => !prevJobIdsRef.current.has(j.id)).map((j) => j.id);
      markRecentlyChanged(added);
    }
    prevJobIdsRef.current = nextIds;
    setGroups(sortedGroups);
    hasDataRef.current = true;
    collectPageCounts(sortedGroups);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [collectPageCounts, markRecentlyChanged]);

  const loadJobsRef = useRef(loadJobs);
  loadJobsRef.current = loadJobs;

  /** Pull every remaining job — the escape hatch behind the "showing N of M" bar. */
  const loadAllJobs = useCallback(async () => {
    jobLimitRef.current = 5000;
    setJobLimit(5000);
    await loadJobsRef.current();
  }, []);

  useEffect(() => {
    loadJobsRef.current();
    loadPrinters();
    const es = openAdminEventSource();
    es.addEventListener("new-job", () => loadJobsRef.current({ soft: true }));
    // One upload can bring in several files, and the server pushes one event
    // per job. Coalesce a burst into a single toast per customer so a 10-file
    // order doesn't stack 10 notifications.
    const pendingCustomers = new Set<string>();
    let importFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushImportToasts = () => {
      importFlushTimer = null;
      if (pendingCustomers.size === 0) return;
      pendingCustomers.forEach((name) => {
        const title = name
          ? rtl
            ? `طلب جديد من الرفع الإلكتروني: ${name}`
            : `New online upload: ${name}`
          : rtl
            ? "زبون مجهول رفع ملفات"
            : "Anonymous uploaded files";
        toast({ title, variant: "success" });
      });
      pendingCustomers.clear();
      new Audio("/notification.mp3").play().catch(() => {});
    };
    es.addEventListener("cloud-job-imported", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        pendingCustomers.add(String(data?.customerName || "").trim());
        if (importFlushTimer) clearTimeout(importFlushTimer);
        importFlushTimer = setTimeout(flushImportToasts, 1500);
      } catch { /* ignored */ }
      loadJobsRef.current({ soft: true });
    });
    es.addEventListener("job-deleted", (e) => {
      let id: string | undefined;
      try {
        id = JSON.parse((e as MessageEvent).data)?.id;
      } catch { /* ignored */ }
      if (id) removeJobById(id);
      else loadJobsRef.current({ soft: true });
    });
    // The server pushes this when a status update to the cloud is rejected —
    // otherwise a shop with an expired token silently shows customers stale
    // statuses. Throttled server-side to one event per minute.
    es.addEventListener("cloud-sync-error", () => {
      toast({
        title: rtl
          ? "فشلت مزامنة الحالة مع السحابة — تحقق من رمز المتجر في الإعدادات"
          : "Cloud status sync failed — check the shop token in Settings",
        variant: "destructive",
      });
    });
    es.onerror = () => {};
    return () => {
      es.close();
      if (importFlushTimer) clearTimeout(importFlushTimer);
      Object.values(highlightTimersRef.current).forEach((t) => clearTimeout(t));
    };
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
        // silent:false keeps the OS print dialog for this one entry point —
        // it is the "let me choose in the driver UI" escape hatch.
        const result = await printFile({ filePath, fileType: job.fileType, silent: false });
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
        // Always the spooler engine — it honours the options above, which the
        // Chromium engine drops. Empty printerName = OS default printer.
        silent: true,
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

  /**
   * Print a job with an explicit option set gathered from the Print Options
   * dialog. Silent (routes straight to the chosen printer) with an honest
   * success / cancel / driver-error toast.
   */
  const printJobWithOptions = async (job: PrintJob, opts: StudioPrintOptions): Promise<PrintOutcome> => {
    if (!isElectron()) {
      toast({
        title: rtl ? "الطباعة الأصلية غير متوفرة" : "Native printing unavailable",
        description: rtl ? "افتح التطبيق من سطح المكتب للطباعة." : "Open the desktop app to print.",
        variant: "destructive",
      });
      return "unsupported";
    }
    const filePath = await storageService.getFileLocalPath(job.id);
    if (!filePath) {
      toast({
        title: rtl ? "تعذر تحديد مسار الملف" : "Could not resolve file path",
        description: job.fileName,
        variant: "destructive",
      });
      return "error";
    }
    const printOptions: Record<string, unknown> = {
      duplexMode: opts.duplexMode,
      color: opts.color,
      copies: Math.max(1, Number(opts.copies) || 1),
      collate: opts.collate,
      landscape: opts.landscape,
    };
    if (opts.pageSize && opts.pageSize !== "default") printOptions.pageSize = opts.pageSize;
    const ranges = parsePageRanges(opts.pageRanges);
    if (ranges.length) printOptions.pageRanges = ranges;
    try {
      const result = await printFile({
        filePath,
        fileType: job.fileType,
        printerName: opts.printerName || defaultPrinterName || "",
        silent: true,
        options: printOptions,
      });
      if (result.cancelled) {
        toast({ title: rtl ? "تم إلغاء الطباعة" : "Print cancelled" });
        return "cancelled";
      }
      if (result.ok) {
        toast({
          title: rtl ? `أُرسلت إلى ${opts.printerName || (rtl ? "الطابعة الافتراضية" : "default printer")}` : `Sent to ${opts.printerName || "default printer"}`,
          description: job.fileName,
          variant: "success",
        });
        return "ok";
      }
      return "error";
    } catch (err) {
      toast({
        title: rtl ? "فشل الطباعة" : "Print failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      return "error";
    }
  };

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
    } catch {
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
    } catch {
      toast({ title: rtl ? "فشل التحديث" : "Update failed", variant: "destructive" });
    }
  };

  const handleEdit = async (job: PrintJob) => {
    if (job.fileType.includes("pdf")) {
      sessionStorage.setItem("ps_edit_job", job.id);
      navigate("/admin/dashboard?tab=studio-pdf");
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
        const updated = await storageService.updateJobFile(editingJob.id, file);
        if (updated) {
          setGroups((prev) =>
            prev.map((g) => ({
              ...g,
              jobs: g.jobs.map((j) => (j.id === updated.id ? updated : j)),
            })),
          );
          setReviewJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
        }
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
    } catch {
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
    const jobId = paymentEditJob.id;
    const nextStatus = paymentEditStatus;
    const nextAmount = paymentEditAmount;

    // Apply locally and close the dialog straight away; the round-trip used to
    // hold the dialog open and then refetch the whole list to show one change.
    let previous: { paymentStatus?: PaymentStatus; paymentAmount?: number } | undefined;
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        jobs: g.jobs.map((j) => {
          if (j.id !== jobId) return j;
          previous = { paymentStatus: j.paymentStatus, paymentAmount: j.paymentAmount };
          return { ...j, paymentStatus: nextStatus as PaymentStatus, paymentAmount: nextAmount };
        }),
      })),
    );
    setPaymentEditJob(null);

    try {
      await storageService.updatePaymentStatus(jobId, nextStatus, nextAmount);
      toast({ title: rtl ? "تم تحديث حالة الدفع" : "Payment status updated", variant: "success" });
    } catch {
      if (previous) {
        const rollback = previous;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            jobs: g.jobs.map((j) =>
              j.id === jobId
                ? { ...j, paymentStatus: rollback.paymentStatus, paymentAmount: rollback.paymentAmount }
                : j,
            ),
          })),
        );
      }
      toast({ title: rtl ? "فشل تحديث الدفع" : "Failed to update payment", variant: "destructive" });
    }
  };

  const handleBulkPaymentStatus = async (status: string) => {
    const ids = Array.from(selectedJobIds);
    const idSet = new Set(ids);
    try {
      await storageService.bulkUpdatePayment(ids, status);
      setSelectedJobIds(new Set());
      // Patch the affected rows instead of refetching and regrouping everything.
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          jobs: g.jobs.map((j) =>
            idSet.has(j.id) ? { ...j, paymentStatus: status as PaymentStatus } : j,
          ),
        })),
      );
      toast({ title: `${ids.length} ${rtl ? "تم تحديث الدفع" : "payment(s) updated"}`, variant: "success" });
    } catch {
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
    refreshing,
    reviewJobs,
    totalJobCount,
    loadAllJobs,
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
    printers,
    recentlyChanged,
    printOptionsJob,
    setPrintOptionsJob,
    printJobWithOptions,
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
