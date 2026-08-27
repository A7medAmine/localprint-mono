import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrintJob, PrintStatus, PaymentStatus, PaperType, DiscountRule } from "../../../types";
import {
  calculatePrintPrice,
  formatPrice,
  calculateJobDiscount,
  calculateCustomerTotalWithDiscounts,
} from "../../../utils/pricingUtils";
import { formatRelativeTime } from "../../../utils/timeUtils";
import ImageEditor from "../../../components/ImageEditor";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useAdmin } from "../AdminContext";
import { isOfficeFile, AdminJobsApi } from "./useAdminJobs";

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

interface JobsPanelProps {
  jobs: AdminJobsApi;
  paperTypes: PaperType[];
  discountRules: DiscountRule[];
  onPreview: (job: PrintJob) => void;
}

const JobsPanel: React.FC<JobsPanelProps> = ({ jobs, paperTypes, discountRules, onPreview }) => {
  const { t, isRtl, lang, settings } = useAdmin();
  const currentSettings = settings;
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const {
    groups,
    loading,
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
  } = jobs;

  const defaultPrinterName = currentSettings.defaultPrinterName || "";

  return (
    <>
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
                                        <Button variant="ghost" size="icon" onClick={() => onPreview(job)} title={isRtl ? "معاينة" : "Preview"} className="text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-white/10 w-8 h-8">
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
    </>
  );
};

export default JobsPanel;
