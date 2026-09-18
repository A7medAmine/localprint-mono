import React, { useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PrintJob, PrintStatus, PaymentStatus, PaperType, DiscountRule } from "../../../types";
import { formatPrice, calculateCustomerTotalWithDiscounts } from "../../../utils/pricingUtils";
import ImageEditor from "../../../components/ImageEditor";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
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
import { useAdmin } from "../AdminContext";
import { AdminJobsApi } from "./useAdminJobs";
import PrintOptionsDialog from "./PrintOptionsDialog";
import { formatRelativeTime } from "../../../utils/timeUtils";
import { StatusBadge, PaymentBadge } from "./JobBadges";
import { makeJobCells } from "./JobCells";
import { readPref, writePref } from "@atba3li/shared/lib/prefs";
import NewJobDialog from "../../../components/NewJobDialog";
import { Icon, type IconName } from "../../../components/ui/icon";
import { ContextMenu, useContextMenu } from "../../../components/ui/context-menu";

interface JobsPanelProps {
  jobs: AdminJobsApi;
  paperTypes: PaperType[];
  discountRules: DiscountRule[];
  onPreview: (job: PrintJob) => void;
}

type StatusFilter = "all" | "pending" | "ready" | "printed";
type PaymentFilter = "all" | "paid" | "partial" | "unpaid";
type SourceFilter = "all" | "upload" | "gmail" | "cloud" | "admin";

const JobsPanel: React.FC<JobsPanelProps> = ({ jobs, paperTypes, discountRules, onPreview }) => {
  const { t, isRtl, lang, settings } = useAdmin();
  const currentSettings = settings;
  const navigate = useNavigate();

  const [newJobOpen, setNewJobOpen] = React.useState(false);

  // Ctrl+N opens the manual job-entry dialog (App.tsx dispatches this event on
  // the dashboard route).
  React.useEffect(() => {
    const onNewJob = () => setNewJobOpen(true);
    window.addEventListener("ps:new-job", onNewJob);
    return () => window.removeEventListener("ps:new-job", onNewJob);
  }, []);

  // Density is a per-device preference, so it lives in localStorage (unlike the
  // shareable, URL-persisted filters).
  const [density, setDensity] = React.useState<"compact" | "cards">(() => {
    return readPref("jobsDensity") === "cards" ? "cards" : "compact";
  });
  React.useEffect(() => {
    try {
      writePref("jobsDensity", density);
    } catch { /* ignored */ }
  }, [density]);

  // Filters live in the URL so a refresh (or a shared link) keeps context.
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get("q") || "";
  const statusFilter = (searchParams.get("status") || "all") as StatusFilter;
  const paymentFilter = (searchParams.get("payment") || "all") as PaymentFilter;
  const sourceFilter = (searchParams.get("source") || "all") as SourceFilter;
  const setParam = (key: string, value: string) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (!value || value === "all") p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true },
    );
  const setSearchQuery = (v: string) => setParam("q", v);
  const filtersActive =
    statusFilter !== "all" || paymentFilter !== "all" || sourceFilter !== "all" || !!searchQuery.trim();
  const clearFilters = () =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        ["q", "status", "payment", "source"].forEach((k) => p.delete(k));
        return p;
      },
      { replace: true },
    );

  const jobMatchesFilters = useCallback((job: PrintJob): boolean => {
    if (statusFilter !== "all") {
      const want =
        statusFilter === "pending"
          ? PrintStatus.PENDING
          : statusFilter === "ready"
          ? PrintStatus.READY
          : PrintStatus.PRINTED;
      if (job.status !== want) return false;
    }
    if (paymentFilter !== "all") {
      const want =
        paymentFilter === "paid"
          ? PaymentStatus.PAID
          : paymentFilter === "partial"
          ? PaymentStatus.PARTIAL
          : PaymentStatus.UNPAID;
      const ps = job.paymentStatus || PaymentStatus.UNPAID;
      if (ps !== want) return false;
    }
    if (sourceFilter !== "all") {
      const src = (job.source as string) || "upload";
      if (sourceFilter === "upload" && src !== "upload" && src !== "web") return false;
      if (sourceFilter === "gmail" && src !== "gmail") return false;
      if (sourceFilter === "cloud" && src !== "cloud" && src !== "online") return false;
      if (sourceFilter === "admin" && src !== "admin") return false;
    }
    return true;
  }, [statusFilter, paymentFilter, sourceFilter]);

  // Hands the selection to the dashboard's own studio tabs (the standalone
  // /admin/studio screen is gone): images open in the photo batch tool, a PDF
  // opens in the PDF tool.
  const sendSelectionToStudio = () => {
    const selected = jobs.groups.flatMap((g) => g.jobs).filter((j) => jobs.selectedJobIds.has(j.id));
    if (selected.length === 0) return;
    const images = selected.filter((j) => j.fileType?.startsWith("image/"));
    if (images.length > 0) {
      sessionStorage.setItem("ps_batch_jobs", JSON.stringify(images.map((j) => j.id)));
      navigate("/admin/dashboard?tab=studio-photos");
      return;
    }
    const pdf = selected.find((j) => j.fileType === "application/pdf");
    if (!pdf) {
      toast({
        title: isRtl ? "لا توجد صور أو ملفات PDF في التحديد" : "Selection has no images or PDFs",
        variant: "destructive",
      });
      return;
    }
    // The PDF tool works on one document at a time.
    sessionStorage.setItem("ps_edit_job", pdf.id);
    navigate("/admin/dashboard?tab=studio-pdf");
  };

  const {
    groups,
    loading,
    refreshing,
    totalJobCount,
    loadAllJobs,
    jobPageCounts,
    selectedJobIds,
    setSelectedJobIds,
    collapsedGroups,
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
    recentlyChanged,
    toggleGroup,
    toggleSelectJob,
    toggleSelectGroup,
    handleBulkPrint,
    handleBulkDownload,
    handleBulkDelete,
    confirmBulkDelete,
    handleBulkStatusUpdate,
    handleBulkPaymentStatus,
    handleSaveEditedImage,
    handlePaymentClick,
    handleSavePayment,
    confirmSingleDelete,
  } = jobs;

  const loadedJobCount = useMemo(
    () => groups.reduce((acc, g) => acc + g.jobs.length, 0),
    [groups],
  );

  // One pass for the summary bar. These were three separate full traversals
  // rebuilt on every keystroke in the search box.
  const statusCounts = useMemo(() => {
    let pending = 0;
    let ready = 0;
    let printed = 0;
    for (const group of groups) {
      for (const job of group.jobs) {
        if (job.status === PrintStatus.PENDING) pending++;
        else if (job.status === PrintStatus.READY) ready++;
        else if (job.status === PrintStatus.PRINTED) printed++;
      }
    }
    return { pending, ready, printed };
  }, [groups]);

  // Filtering ran inline in the JSX, so every render — including each keystroke
  // in the search box — rebuilt and re-spread every group.
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const phoneQuery = searchQuery.trim();
    return groups
      .map((g) => {
        const groupMatchesSearch =
          !q ||
          g.customerName.toLowerCase().includes(q) ||
          g.customerEmail.toLowerCase().includes(q) ||
          g.phoneNumber.includes(phoneQuery);
        const matched = g.jobs.filter(
          (job) =>
            jobMatchesFilters(job) &&
            (groupMatchesSearch || job.fileName.toLowerCase().includes(q)),
        );
        return matched.length === g.jobs.length ? g : { ...g, jobs: matched };
      })
      .filter((g) => g.jobs.length > 0);
  }, [groups, searchQuery, jobMatchesFilters]);

  // Render groups in windows. Mounting several hundred customer cards (each
  // with a full job table) in one pass is what makes the first paint after
  // "Load all" — or a large search reset — hang for seconds.
  const GROUP_PAGE = 25;
  const [visibleGroupCount, setVisibleGroupCount] = React.useState(GROUP_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  // Any change to the result set starts the window over at the top.
  React.useEffect(() => {
    setVisibleGroupCount(GROUP_PAGE);
  }, [searchQuery, statusFilter, paymentFilter, sourceFilter, groups.length]);

  const visibleGroups = useMemo(
    () => filteredGroups.slice(0, visibleGroupCount),
    [filteredGroups, visibleGroupCount],
  );

  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node || visibleGroupCount >= filteredGroups.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleGroupCount((n) => n + GROUP_PAGE);
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleGroupCount, filteredGroups.length]);

  const defaultPrinterName = currentSettings.defaultPrinterName || "";

  // Per-job cells live in JobCells.tsx; both densities render the same ones.
  // One menu instance serves every row: the hook remembers which job was
  // right-clicked and where the pointer was.
  const jobMenu = useContextMenu<PrintJob>();

  const { renderFileInfo, renderSettingsControls, renderCost, renderActions, renderJobCard, buildJobMenu } =
    makeJobCells({
      jobs,
      paperTypes,
      discountRules,
      onPreview,
      currentSettings,
      defaultPrinterName,
      t,
      isRtl,
      onJobContextMenu: jobMenu.open,
    });


  return (
    <>
      {jobMenu.state && (
        <ContextMenu
          x={jobMenu.state.x}
          y={jobMenu.state.y}
          isRtl={isRtl}
          title={
            selectedJobIds.size > 1 && selectedJobIds.has(jobMenu.state.payload.id)
              ? isRtl
                ? `${selectedJobIds.size} ملفات محددة`
                : `${selectedJobIds.size} files selected`
              : jobMenu.state.payload.fileName
          }
          items={buildJobMenu(jobMenu.state.payload)}
          onClose={jobMenu.close}
        />
      )}
            {/* A refresh over existing rows shows this hairline instead of
                replacing the list with a skeleton. */}
            <div className="h-0.5 -mt-0.5 mb-1 overflow-hidden" aria-hidden={!refreshing}>
              {refreshing && (
                <div className="h-full w-1/3 bg-indigo-500/70 rounded-full animate-[ps-refresh_1.1s_ease-in-out_infinite]" />
              )}
            </div>
            {/* Manual job entry */}
            <div className="flex items-center justify-between mb-3">
              <Button onClick={() => setNewJobOpen(true)} size="sm" className="h-8 px-3 text-xs bg-indigo-600 hover:bg-indigo-500 text-white">
                <Icon name="plus" className="w-3.5 h-3.5 me-1.5" />
                {t("newJob")}
              </Button>
              {!loading && groups.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {isRtl ? "اضغط Ctrl+N لطلب جديد" : "Ctrl+N for a new job"}
                </span>
              )}
            </div>
            {/* The list loads the newest page; older jobs are one click away so a
                shop with years of history doesn't pay for them on every refresh. */}
            {!loading && totalJobCount > loadedJobCount && (
              <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
                <span className="text-xs text-amber-800 dark:text-amber-200">
                  {isRtl
                    ? `عرض أحدث ${loadedJobCount} من أصل ${totalJobCount} طلب`
                    : `Showing the newest ${loadedJobCount} of ${totalJobCount} jobs`}
                </span>
                <Button
                  onClick={loadAllJobs}
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs shrink-0"
                >
                  {isRtl ? "تحميل الكل" : "Load all"}
                </Button>
              </div>
            )}
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
                <div className="flex items-center gap-3 border-r border-white/20 pe-6 me-2">
                  <span className="bg-indigo-50 dark:bg-indigo-900/20 text-white dark:text-gray-100 w-7 h-7 rounded-full flex items-center justify-center font-bold text-sm">
                    {selectedJobIds.size}
                  </span>
                  <span className="text-sm font-medium whitespace-nowrap">
                    {t("selectedItems")}
                  </span>
                </div>

                <div className="flex items-center gap-2 md:gap-4">
                  <Button variant="ghost" size="sm" onClick={handleBulkPrint} title={t("bulkPrint")} className="flex-col gap-1 h-auto text-inherit hover:text-indigo-400 dark:hover:text-indigo-300">
                    <Icon name="print" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("print")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleBulkDownload} title={t("bulkDownload")} className="flex-col gap-1 h-auto text-inherit hover:text-indigo-400 dark:hover:text-indigo-300">
                    <Icon name="download" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("download")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkStatusUpdate(PrintStatus.PRINTED)} title={t("markAsPrinted")} className="flex-col gap-1 h-auto text-inherit hover:text-green-400 dark:hover:text-green-300">
                    <Icon name="check-all" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("printed")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkStatusUpdate(PrintStatus.READY)} title={t("markReady")} className="flex-col gap-1 h-auto text-inherit hover:text-blue-400 dark:hover:text-blue-300">
                    <Icon name="package" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("ready")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkPaymentStatus(PaymentStatus.PAID)} title={t("markPaid")} className="flex-col gap-1 h-auto text-inherit hover:text-green-400 dark:hover:text-green-300">
                    <Icon name="money" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("paid")}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBulkPaymentStatus(PaymentStatus.UNPAID)} title={t("markUnpaid")} className="flex-col gap-1 h-auto text-inherit hover:text-red-400 dark:hover:text-red-300">
                    <Icon name="money-off" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("unpaid")}</span>
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
                        navigate("/admin/dashboard?tab=studio-cards");
                      }} title="Print as Card" className="flex-col gap-1 h-auto text-inherit hover:text-pink-400 dark:hover:text-pink-300">
                        <Icon name="card" className="w-5 h-5" />
                        <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{isRtl ? "بطاقة" : "Card"}</span>
                      </Button>
                    ) : null;
                  })()}
                  <Button variant="ghost" size="sm" onClick={sendSelectionToStudio} title={isRtl ? "إرسال إلى استوديو الطباعة" : "Send to Print Studio"} className="flex-col gap-1 h-auto text-inherit hover:text-indigo-400 dark:hover:text-indigo-300">
                    <Icon name="wand" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{isRtl ? "استوديو" : "Studio"}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleBulkDelete} title={t("bulkDelete")} className="flex-col gap-1 h-auto text-inherit hover:text-red-400 dark:hover:text-red-300">
                    <Icon name="trash" className="w-5 h-5" />
                    <span className="text-xs hidden sm:block uppercase tracking-wider font-bold">{t("delete")}</span>
                  </Button>
                </div>

                <Button variant="ghost" size="icon" onClick={() => setSelectedJobIds(new Set())}
                  aria-label={isRtl ? "إلغاء التحديد" : "Clear selection"} className="ms-4 text-white hover:bg-white dark:bg-gray-800/10">
                  <Icon name="x" className="w-5 h-5" />
                </Button>
              </div>
            )}
            {/* Stats Summary Bar */}
            {!loading && groups.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mb-3">
                <div className="bg-card rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center flex-shrink-0">
                    <Icon name="clock" className="w-4 h-4 text-yellow-600 dark:text-yellow-100" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-yellow-600 dark:text-yellow-200 leading-none">{statusCounts.pending}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">{isRtl ? "قيد الانتظار" : "Pending"}</span>
                  </div>
                </div>
                <div className="bg-card rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                    <Icon name="check" className="w-4 h-4 text-blue-600 dark:text-blue-100" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-blue-600 dark:text-blue-200 leading-none">{statusCounts.ready}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">{isRtl ? "جاهز للاستلام" : "Ready"}</span>
                  </div>
                </div>
                <div className="bg-card rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900 flex items-center justify-center flex-shrink-0">
                    <Icon name="check-circle" className="w-4 h-4 text-green-600 dark:text-green-100" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-green-600 dark:text-green-200 leading-none">{statusCounts.printed}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">{isRtl ? "تمت الطباعة" : "Printed"}</span>
                  </div>
                </div>
                <div className="bg-card rounded-lg px-4 shadow-sm dark:shadow-gray-900/50 border border-gray-100 dark:border-gray-600 flex items-center gap-3 min-h-[72px]">
                  <div className="w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center flex-shrink-0">
                    <Icon name="users" className="w-4 h-4 text-indigo-600 dark:text-indigo-100" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-indigo-600 dark:text-indigo-200 leading-none">{groups.length}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">{isRtl ? "إجمالي العملاء" : "Customers"}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Search Bar */}
            {!loading && groups.length > 0 && (
              <div className="relative my-3">
                <div className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <Icon name="search" className="w-4 h-4" />
                </div>
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isRtl ? "ابحث بالاسم أو رقم الهاتف..." : "Search by name or phone..."}
                  className="ps-9 pe-4"
                />
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSearchQuery("")}
                    aria-label={isRtl ? "مسح البحث" : "Clear search"}
                    className="absolute end-1 top-1/2 -translate-y-1/2 h-8 w-8"
                  >
                    <Icon name="x" className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )}

            {/* Filter bar — URL-persisted (?status= &payment= &source=) */}
            {!loading && groups.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
                <div className="flex items-center gap-1">
                  {([
                    ["all", isRtl ? "الكل" : "All"],
                    ["pending", isRtl ? "قيد الانتظار" : "Pending"],
                    ["ready", isRtl ? "جاهز" : "Ready"],
                    ["printed", isRtl ? "مطبوع" : "Printed"],
                  ] as [StatusFilter, string][]).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setParam("status", v)}
                      className={`px-2.5 py-1 rounded-lg font-medium ${
                        statusFilter === v
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  {([
                    ["all", isRtl ? "كل الدفع" : "Any pay"],
                    ["paid", isRtl ? "مدفوع" : "Paid"],
                    ["partial", isRtl ? "جزئي" : "Partial"],
                    ["unpaid", isRtl ? "غير مدفوع" : "Unpaid"],
                  ] as [PaymentFilter, string][]).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setParam("payment", v)}
                      className={`px-2.5 py-1 rounded-lg font-medium ${
                        paymentFilter === v
                          ? "bg-green-600 text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select
                  value={sourceFilter}
                  onChange={(e) => setParam("source", e.target.value)}
                  className="px-2 py-1 rounded-lg border border-border bg-card text-foreground"
                >
                  <option value="all">{isRtl ? "كل المصادر" : "Any source"}</option>
                  <option value="upload">{isRtl ? "رفع" : "Upload"}</option>
                  <option value="gmail">Gmail</option>
                  <option value="cloud">{isRtl ? "سحابة" : "Cloud"}</option>
                  <option value="admin">{t("adminSource")}</option>
                </select>
                {filtersActive && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="px-2.5 py-1 rounded-lg font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    {isRtl ? "مسح التصفية" : "Clear filters"}
                  </button>
                )}
                <div className="flex items-center gap-1 ms-auto">
                  {([
                    ["compact", "layout-rows", isRtl ? "جدول" : "Compact"],
                    ["cards", "layout-grid", isRtl ? "بطاقات" : "Cards"],
                  ] as ["compact" | "cards", IconName, string][]).map(([v, icon, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setDensity(v)}
                      title={label}
                      aria-label={label}
                      aria-pressed={density === v}
                      className={`p-1.5 rounded-lg ${
                        density === v
                          ? "bg-slate-700 text-white dark:bg-slate-600"
                          : "bg-muted text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      <Icon name={icon} className="w-4 h-4" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loading ? (
              <div className="space-y-3 animate-pulse">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="flex items-center px-4 py-3 gap-3 border-b border-border">
                      <div className="w-4 h-4 rounded bg-muted shrink-0" />
                      <div className="w-8 h-8 rounded-full bg-muted shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3.5 w-36 rounded-full bg-muted" />
                        <div className="h-3 w-24 rounded-full bg-muted" />
                      </div>
                      <div className="h-5 w-16 rounded-full bg-muted" />
                      <div className="h-5 w-5 rounded bg-muted" />
                    </div>
                    <div className="px-4 py-2 space-y-2">
                      {[1, 2].map((j) => (
                        <div key={j} className="flex items-center gap-3 min-h-[80px] py-2">
                          <div className="w-4 h-4 rounded bg-muted shrink-0" />
                          <div className="w-10 h-10 rounded bg-muted shrink-0" />
                          <div className="flex-1 space-y-1">
                            <div className="h-3 w-44 rounded-full bg-muted" />
                            <div className="h-2.5 w-28 rounded-full bg-muted" />
                          </div>
                          <div className="h-5 w-16 rounded-full bg-muted" />
                          <div className="h-5 w-12 rounded-full bg-muted" />
                          <div className="flex gap-1">
                            <div className="w-8 h-8 rounded bg-muted" />
                            <div className="w-8 h-8 rounded bg-muted" />
                            <div className="w-8 h-8 rounded bg-muted" />
                            <div className="w-8 h-8 rounded bg-muted" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="px-6 py-14 sm:py-16 bg-card rounded-xl border border-border overflow-hidden">
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
                  <h3 className="text-lg font-semibold text-foreground">
                    {isRtl ? "لا توجد طلبات طباعة بعد" : "No print jobs yet"}
                  </h3>
                  <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                    {isRtl
                      ? "الطابعة مرتاحة الآن. أول طلب يصل سيظهر هنا مباشرة."
                      : "Your printer is taking a breather. New jobs will land here the moment they arrive."}
                  </p>
                </div>
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground bg-card rounded-xl border border-border">
                <Icon name="search" className="w-10 h-10 mx-auto mb-2 text-gray-300 dark:text-gray-500" />
                <p>{isRtl ? "لا توجد نتائج" : "No results found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleGroups.map((group) => {
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
                      className="bg-card rounded-xl border border-border overflow-hidden mb-2 transition-all shadow-sm"
                    >
                      <div className="flex items-center border-b border-border bg-card group/header">
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
                          className="flex-1 px-2 py-2.5 flex items-center justify-between hover:bg-muted/40 transition-colors"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                pendingCount > 0
                                  ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              <Icon name="user" className="w-4 h-4" />
                            </div>
                            <div className="truncate text-start">
                              <h3 className="text-sm font-bold text-foreground truncate">
                                {group.customerName ||
                                  group.customerEmail ||
                                  (isRtl ? "بدون اسم" : "No Name")}
                              </h3>
                              <p className="text-xs text-muted-foreground truncate">
                                {/* Email-imported orders have no phone — show
                                    the sender address there instead. */}
                                {group.phoneNumber ||
                                  (group.customerName && group.customerEmail) ||
                                  (isRtl ? "بدون هاتف" : "No Phone")}
                                {" · "}
                                <span className="text-muted-foreground">{formatRelativeTime(group.latestDate, lang)}</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {customerTotal > 0 && (
                              <div className="flex flex-col items-end">
                                {customerDiscount > 0 && (
                                  <span className="text-xs text-muted-foreground line-through">
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
                            <Icon name="chevron-down" className={`w-5 h-5 text-muted-foreground transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`} />
                          </div>
                        </button>
                      </div>
                      {isExpanded && density === "compact" && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-start border-collapse">
                            <thead className="bg-muted/40 border-b border-border">
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
                                  className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {t("fileName")}
                                </th>
                                <th
                                  className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {isRtl ? "الإعدادات" : "Settings"}
                                </th>
                                <th
                                  className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {isRtl ? "التكلفة" : "Cost"}
                                </th>
                                <th
                                  className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {t("status")}
                                </th>
                                <th
                                  className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {t("payment")}
                                </th>
                                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                  {t("actions")}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                              {group.jobs.map((job) => {
                                const isSelected = selectedJobIds.has(job.id);

                                return (
                                  <tr
                                    key={job.id}
                                    onContextMenu={jobMenu.open(job)}
                                    className={`group/row transition-all duration-200 border-b border-gray-100 dark:border-white/10 ${
                                      recentlyChanged.has(job.id)
                                        ? "bg-amber-100 dark:bg-amber-900/30"
                                        : isSelected
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
                                      {renderFileInfo(job)}
                                    </td>

                                    {/* Settings Cell (Color & Copies) */}
                                    <td className="px-4 py-2 align-top">
                                      {renderSettingsControls(job)}
                                    </td>

                                    {/* Cost Cell */}
                                    <td className="px-4 py-2 align-middle whitespace-nowrap">
                                      {renderCost(job)}
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      <StatusBadge job={job} onStatusChange={jobs.handleStatusChange} />
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      <PaymentBadge job={job} onEdit={handlePaymentClick} />
                                    </td>
                                    <td className="px-4 py-2 align-middle">
                                      {renderActions(job)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {isExpanded && density === "cards" && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-1">
                          {group.jobs.map((job) => renderJobCard(job))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {visibleGroupCount < filteredGroups.length && (
                  <div ref={sentinelRef} className="py-6 text-center text-xs text-muted-foreground">
                    {isRtl
                      ? `جارٍ عرض ${visibleGroups.length} من ${filteredGroups.length} زبون…`
                      : `Showing ${visibleGroups.length} of ${filteredGroups.length} customers…`}
                  </div>
                )}
              </div>
            )}
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
              <label className="block text-sm font-semibold text-foreground mb-2">{t("paymentAmount")} (DZD)</label>
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

      <PrintOptionsDialog
        job={jobs.printOptionsJob}
        printers={jobs.printers}
        settings={currentSettings}
        onClose={() => jobs.setPrintOptionsJob(null)}
        onPrint={jobs.printJobWithOptions}
      />

      <NewJobDialog open={newJobOpen} onOpenChange={setNewJobOpen} paperTypes={paperTypes} onCreated={() => jobs.loadJobs()} />
    </>
  );
};

export default JobsPanel;
