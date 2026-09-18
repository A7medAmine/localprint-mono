import React, { useEffect, useState } from "react";
import { PrintJob, PaperType, DiscountRule, ShopSettings, PrintStatus, PaymentStatus } from "../../../types";
import {
  calculatePrintPrice,
  formatPrice,
  calculateJobDiscount,
} from "../../../utils/pricingUtils";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Icon } from "../../../components/ui/icon";
import type { ContextMenuEntry } from "../../../components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { isOfficeFile, AdminJobsApi } from "./useAdminJobs";
import { SourceBadge, StatusBadge, PaymentBadge } from "./JobBadges";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";

/** Small image thumbnail for the job row, fetched through the token-protected
 * review endpoint (public endpoint hides jobs still awaiting review). PDFs
 * aren't thumbnailed — rendering a first-page preview needs pdf.js per row,
 * too heavy for a list that can hold hundreds of jobs. */
const JobThumbnail: React.FC<{ job: PrintJob }> = ({ job }) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    storageService.getAdminFileUrl(job.id).then((u) => {
      if (cancelled) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      objectUrl = u;
      setUrl(u);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [job.id]);

  if (!url) {
    return <div className="w-10 h-10 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse flex-shrink-0" />;
  }
  return (
    <img
      src={url}
      alt=""
      className="w-10 h-10 rounded-md object-cover border border-border flex-shrink-0"
    />
  );
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

export interface JobCellDeps {
  jobs: AdminJobsApi;
  paperTypes: PaperType[];
  discountRules: DiscountRule[];
  onPreview: (job: PrintJob) => void;
  currentSettings: ShopSettings;
  defaultPrinterName: string;
  t: (key: string) => string;
  isRtl: boolean;
  /** Right-click handler factory from `useContextMenu`, wired on rows and cards. */
  onJobContextMenu?: (job: PrintJob) => (e: React.MouseEvent) => void;
}

/**
 * The per-job cells: file info, print settings, cost, row actions, and the card
 * that wraps them in the non-table density.
 *
 * They are built from one dependency bag instead of closing over JobsPanel's
 * locals, which is what let the panel grow past 1,500 lines. Both densities
 * render the same cells, so the compact table and the cards grid cannot drift.
 */
export function makeJobCells({
  jobs,
  paperTypes,
  discountRules,
  onPreview,
  currentSettings,
  defaultPrinterName,
  t,
  isRtl,
  onJobContextMenu,
}: JobCellDeps) {
  const {
    jobPageCounts,
    selectedJobIds,
    expandedNotes,
    editingCopiesJobId,
    setEditingCopiesJobId,
    editingCopiesValue,
    setEditingCopiesValue,
    savingPrefsJobId,
    recentlyChanged,
    toggleSelectJob,
    toggleNoteExpand,
    handleDownload,
    handleQuickPrint,
    handleOpenInApp,
    handleEdit,
    handleStatusChange,
    handlePaymentClick,
    handleDelete,
    handlePaperTypeChange,
    handleToggleColorMode,
    handleSaveCopies,
  } = jobs;

    const renderFileInfo = (job: PrintJob) => {
      const ext = getFileExtension(job.fileName);
      const officeFile = isOfficeFile(job.fileType);
      const isImage = job.fileType?.startsWith("image/");
      return (
        <>
          <div className="flex items-center gap-3 w-full">
            {isImage ? (
              <JobThumbnail job={job} />
            ) : (
              <span
                className={`text-xs font-bold px-2 py-1 rounded-md border flex-shrink-0 ${
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
            )}
            <div className="flex flex-col flex-1 min-w-0">
              <span className="flex items-center gap-1.5">
                <span
                  className="text-sm font-semibold text-foreground truncate"
                  title={job.fileName}
                >
                  {job.fileName}
                </span>
                <SourceBadge job={job} />
              </span>
              <span className="text-xs text-muted-foreground">
                {formatSize(job.fileSize)}
              </span>
            </div>
          </div>
          {job.notes && (
            <div className="mt-2">
              {expandedNotes.has(job.id) || !job.id.startsWith("gmail_") ? (
                <div className="text-xs text-indigo-600 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 px-2 py-1 rounded-md inline-block font-medium max-w-xs break-words">
                  {job.notes}
                </div>
              ) : (
                <>
                  <div className="text-xs text-indigo-600 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 px-2 py-1 rounded-md inline-block font-medium max-w-xs break-words">
                    {job.notes.length > 120 ? job.notes.slice(0, 120) + "..." : job.notes}
                  </div>
                  {job.notes.length > 120 && (
                    <button type="button" onClick={() => toggleNoteExpand(job.id)} className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-400 dark:hover:text-indigo-300 ms-1 align-middle underline">
                      {isRtl ? "قراءة المزيد" : "Read more"}
                    </button>
                  )}
                </>
              )}
              {expandedNotes.has(job.id) && (
                <button onClick={() => toggleNoteExpand(job.id)} className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-400 dark:hover:text-indigo-300 ms-1 align-middle underline">
                  {isRtl ? "طي" : "Less"}
                </button>
              )}
            </div>
          )}
        </>
      );
    };

    const renderSettingsControls = (job: PrintJob) =>
      job.printPreferences && (
        <div className="flex flex-col gap-1 w-max">
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              title={isRtl ? "انقر للتبديل" : "Toggle mode"}
              disabled={savingPrefsJobId === job.id}
              onClick={() => handleToggleColorMode(job)}
              variant={job.printPreferences.colorMode === "blackWhite" ? "secondary" : "default"}
              size="sm"
              className="text-xs h-8 px-2.5"
            >
              {savingPrefsJobId === job.id ? (
                <Icon name="spinner" className="animate-spin w-3 h-3" />
              ) : (
                <>
                  <Icon name={job.printPreferences.colorMode === "blackWhite" ? "grayscale" : "color"} className="w-3.5 h-3.5" />
                  {job.printPreferences.colorMode === "blackWhite" ? (isRtl ? "أبيض وأسود" : "B&W") : (isRtl ? "ملون" : "Color")}
                </>
              )}
            </Button>

            {/* Copies Stepper */}
            {editingCopiesJobId === job.id ? (
              <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-0.5 shadow-sm dark:shadow-gray-900/50 w-max">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
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
                  className="w-10 text-center text-xs font-semibold h-8 px-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setEditingCopiesValue((v) => Math.min(100, v + 1))}
                >+</Button>
                <Button
                  type="button"
                  size="icon"
                  aria-label={isRtl ? "حفظ عدد النسخ" : "Save copies"}
                  className="h-8 w-8 ms-1"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSaveCopies(job, editingCopiesValue)}
                >
                  <Icon name="check" className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs h-8 px-2.5"
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
              <SelectTrigger disabled={savingPrefsJobId === job.id} className="h-8 text-xs px-2 py-0 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900 text-amber-700 dark:text-amber-100 rounded-lg font-medium w-auto gap-1 focus:ring-amber-500 dark:focus:ring-amber-400">
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
      );

    const renderCost = (job: PrintJob) =>
      (currentSettings.pricing || (currentSettings.paperTypes && currentSettings.paperTypes.length > 0)) ? (
        (() => {
          const isOffice = job.fileType?.includes("word") || job.fileType?.includes("document") || job.fileType?.includes("excel") || job.fileType?.includes("spreadsheet") || job.fileType?.includes("presentation") || job.fileType?.includes("powerpoint");
          if (isOffice) return <span className="text-xs text-muted-foreground">-</span>;
          const pageCount = jobPageCounts[job.id] || 1;
          const priceCalc = calculatePrintPrice(job, currentSettings, pageCount);
          const discountResult = calculateJobDiscount(job, priceCalc.totalPrice, priceCalc.totalPages, discountRules);
          const hasDiscount = discountResult.discountAmount > 0;

          return (
            <div className="flex flex-col gap-1">
              <div className="flex flex-col">
                {hasDiscount && (
                  <span className="text-xs text-muted-foreground line-through">
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
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                <span>
                  {isRtl ? "الصفحات:" : "Pages:"}
                </span>
                <span className="font-bold text-indigo-700 dark:text-indigo-100 bg-indigo-50 dark:bg-indigo-900 border border-indigo-100 dark:border-indigo-800 px-2 py-0.5 rounded text-xs">
                  {pageCount}
                </span>
              </div>
            </div>
          );
        })()
      ) : (
        <span className="text-xs text-muted-foreground">
          -
        </span>
      );

    const renderActions = (job: PrintJob) => {
      const officeFile = isOfficeFile(job.fileType);
      return (
        <div className="flex items-center gap-0.5 w-max">
          {officeFile ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleOpenInApp(job)}
              title={isRtl ? "فتح في التطبيق" : "Open in default app"}
              className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
             aria-label={isRtl ? "فتح في التطبيق" : "Open in default app"}>
              <Icon name="external" className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleQuickPrint(job)}
              aria-label={isRtl ? "طباعة سريعة" : "Quick print"}
                title={isRtl ? `طباعة سريعة${defaultPrinterName ? ` — ${defaultPrinterName}` : ""}` : `Quick Print${defaultPrinterName ? ` — ${defaultPrinterName}` : ""}`}
                className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
              >
                <Icon name="zap" className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => jobs.setPrintOptionsJob(job)}
                title={isRtl ? "خيارات الطباعة…" : "Print options…"}
                className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-white/10 w-8 h-8"
               aria-label={isRtl ? "خيارات الطباعة…" : "Print options…"}>
                <Icon name="print" className="w-4 h-4" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={() => onPreview(job)} title={isRtl ? "معاينة" : "Preview"} className="text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-white/10 w-8 h-8" aria-label={isRtl ? "معاينة" : "Preview"}>
            <Icon name="eye" className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => handleEdit(job)} title={t("edit")} className="text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-white/10 w-8 h-8" aria-label={t("edit")}>
            <Icon name="edit" className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => handleDownload(job)} title={t("download")} className="text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-white/10 w-8 h-8" aria-label={t("download")}>
            <Icon name="download" className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => handleDelete(job.id)} title={t("delete")} className="text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-white/10 w-8 h-8" aria-label={t("delete")}>
            <Icon name="trash" className="w-4 h-4" />
          </Button>
        </div>
      );
    };

    /**
     * The right-click menu for a job row (and for the card in the other density).
     *
     * It mirrors the row buttons plus the things that otherwise need a trip to a
     * badge or the bulk bar: status, payment, copying the file name. Right-clicking
     * a row inside a multi-row selection acts on the whole selection instead —
     * that is what every file manager does, and it is the only way to reach the
     * bulk actions without first hunting for the bar at the top.
     */
    const buildJobMenu = (job: PrintJob): ContextMenuEntry[] => {
      const officeFile = isOfficeFile(job.fileType);
      const selectedCount = selectedJobIds.size;
      const bulk = selectedCount > 1 && selectedJobIds.has(job.id);

      const copyToClipboard = async (text: string, label: string) => {
        try {
          await navigator.clipboard.writeText(text);
          toast({ title: label, variant: "success" });
        } catch {
          toast({ title: isRtl ? "تعذر النسخ" : "Copy failed", variant: "destructive" });
        }
      };

      if (bulk) {
        return [
          {
            label: isRtl ? `طباعة ${selectedCount} ملفات` : `Print ${selectedCount} files`,
            icon: "zap",
            disabled: jobs.bulkPrinting,
            onSelect: () => jobs.handleBulkPrint(),
          },
          {
            label: isRtl ? "تنزيل المحدد" : "Download selected",
            icon: "download",
            onSelect: () => jobs.handleBulkDownload(),
          },
          { type: "separator" },
          {
            label: isRtl ? "تعليم كمطبوع" : "Mark as printed",
            icon: "check-all",
            onSelect: () => jobs.handleBulkStatusUpdate(PrintStatus.PRINTED),
          },
          {
            label: isRtl ? "تعليم كجاهز" : "Mark as ready",
            icon: "check",
            onSelect: () => jobs.handleBulkStatusUpdate(PrintStatus.READY),
          },
          {
            label: isRtl ? "تعليم كمدفوع" : "Mark as paid",
            icon: "money",
            onSelect: () => jobs.handleBulkPaymentStatus(PaymentStatus.PAID),
          },
          {
            label: isRtl ? "تعليم كغير مدفوع" : "Mark as unpaid",
            icon: "money-off",
            onSelect: () => jobs.handleBulkPaymentStatus(PaymentStatus.UNPAID),
          },
          { type: "separator" },
          {
            label: isRtl ? `حذف ${selectedCount} ملفات` : `Delete ${selectedCount} files`,
            icon: "trash",
            destructive: true,
            onSelect: () => jobs.handleBulkDelete(),
          },
        ];
      }

      const printEntries: ContextMenuEntry[] = officeFile
        ? [
            {
              label: isRtl ? "فتح في التطبيق" : "Open in default app",
              icon: "external",
              onSelect: () => handleOpenInApp(job),
            },
          ]
        : [
            {
              label: isRtl ? "طباعة سريعة" : "Quick print",
              icon: "zap",
              hint: defaultPrinterName || undefined,
              onSelect: () => handleQuickPrint(job),
            },
            {
              label: isRtl ? "خيارات الطباعة…" : "Print options…",
              icon: "print",
              onSelect: () => jobs.setPrintOptionsJob(job),
            },
          ];

      return [
        ...printEntries,
        {
          label: isRtl ? "معاينة" : "Preview",
          icon: "eye",
          onSelect: () => onPreview(job),
        },
        { label: t("edit"), icon: "edit", onSelect: () => handleEdit(job) },
        { label: t("download"), icon: "download", onSelect: () => handleDownload(job) },
        { type: "separator" },
        {
          label: isRtl ? "قيد الانتظار" : "Mark pending",
          icon: "clock",
          checked: job.status === PrintStatus.PENDING,
          onSelect: () => handleStatusChange(job.id, PrintStatus.PENDING),
        },
        {
          label: isRtl ? "جاهز" : "Mark ready",
          icon: "check",
          checked: job.status === PrintStatus.READY,
          onSelect: () => handleStatusChange(job.id, PrintStatus.READY),
        },
        {
          label: isRtl ? "مطبوع" : "Mark printed",
          icon: "check-all",
          checked: job.status === PrintStatus.PRINTED,
          onSelect: () => handleStatusChange(job.id, PrintStatus.PRINTED),
        },
        { type: "separator" },
        {
          label: isRtl ? "تعديل الدفع…" : "Edit payment…",
          icon: "money",
          onSelect: () => handlePaymentClick(job),
        },
        {
          label: isRtl ? "نسخ اسم الملف" : "Copy file name",
          icon: "copy",
          onSelect: () =>
            copyToClipboard(job.fileName, isRtl ? "تم نسخ اسم الملف" : "File name copied"),
        },
        {
          label: isRtl ? "نسخ رقم الطلب" : "Copy job ID",
          icon: "tag",
          onSelect: () => copyToClipboard(job.id, isRtl ? "تم نسخ الرقم" : "Job ID copied"),
        },
        { type: "separator" },
        {
          label: t("delete"),
          icon: "trash",
          destructive: true,
          onSelect: () => handleDelete(job.id),
        },
      ];
    };

    const renderJobCard = (job: PrintJob) => {
      const isSelected = selectedJobIds.has(job.id);
      return (
        <div
          key={job.id}
          onContextMenu={onJobContextMenu?.(job)}
          className={`rounded-2xl border p-3 transition-all duration-200 flex flex-col gap-3 ${
            recentlyChanged.has(job.id)
              ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20"
              : isSelected
              ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/20"
              : "border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900"
          }`}
        >
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              className="w-4 h-4 mt-1 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 dark:focus:ring-indigo-400 cursor-pointer shrink-0"
              checked={isSelected}
              onChange={() => toggleSelectJob(job.id)}
            />
            <div className="flex-1 min-w-0">{renderFileInfo(job)}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge job={job} onStatusChange={handleStatusChange} />
            <PaymentBadge job={job} onEdit={handlePaymentClick} />
          </div>
          {renderSettingsControls(job)}
          <div>{renderCost(job)}</div>
          <div className="pt-1 border-t border-gray-100 dark:border-white/10">{renderActions(job)}</div>
        </div>
      );
    };

  return { renderFileInfo, renderSettingsControls, renderCost, renderActions, renderJobCard, buildJobMenu };
}
