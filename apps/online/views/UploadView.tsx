import React, { useState, useRef, useEffect } from "react";
import { Language, PrintJob, PrintStatus, ShopSettings, DiscountRule } from "../types";
import { TRANSLATIONS, ALLOWED_TYPES } from "../constants";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { useAuth } from "../hooks/useAuth";
import { Toaster } from "../components/ui/toaster";
import { Button } from "../components/ui/button";
import ShareQrDialog from "../components/ShareQrDialog";
import { directionsUrl } from "@atba3li/shared/geo";
import { Icon } from "../components/ui/icon";
import { UploadForm, UploadPrintPreferences, FilePrintOverrides } from "@atba3li/shared/components/upload/UploadForm";
import { RecentUploads } from "@atba3li/shared/components/upload/RecentUploads";
import { UploadDialogs } from "@atba3li/shared/components/upload/UploadDialogs";
import { StoreFooter } from "@atba3li/shared/components/upload/StoreFooter";
import {
  isOfficeFile,
  isOfficeType,
  makeFilePriceCalculator,
  usePageCounts,
} from "@atba3li/shared/lib/useUploadPricing";

interface UploadViewProps {
  lang: Language;
  shopSlug: string;
  shopSettings?: ShopSettings;
}

interface FileStatus {
  file: File;
  progress: number;
  status: "pending" | "uploading" | "success" | "error";
  id: string;
}

// Custom ID generator that works in non-secure contexts (HTTP over Local IP)
const generateSafeId = () => {
  return Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
};

const UploadView: React.FC<UploadViewProps> = ({ lang, shopSlug, shopSettings: propSettings }) => {
  const t = (key: string) => TRANSLATIONS[key][lang] || key;
  const isRtl = lang === "ar";
  // toast() imported from use-toast, called directly

  // Optional customer account — guest upload works identically whether or not
  // this resolves to a logged-in user.
  const { user, accessToken } = useAuth();
  const appliedProfileDefaults = useRef(false);

  // Confirm dialog state for canceling jobs
  const [cancelConfirm, setCancelConfirm] = useState<{
    isOpen: boolean;
    jobId: string | null;
  }>({ isOpen: false, jobId: null });
  const [storeInfoOpen, setStoreInfoOpen] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    notes: "",
  });
  const [printPreferences, setPrintPreferences] = useState<{
    colorMode: "color" | "blackWhite";
    copies: number;
    paperType: string;
  }>({
    colorMode: "color",
    copies: 1,
    paperType: "normal",
  });
  const [fileOverrides, setFileOverrides] = useState<FilePrintOverrides>({});
  const [selectedFiles, setSelectedFiles] = useState<FileStatus[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [overallSuccess, setOverallSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<PrintJob[]>([]);
  const [shareQrOpen, setShareQrOpen] = useState(false);

  // Preview States
  const [previewJob, setPreviewJob] = useState<{ job: PrintJob; url: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Pricing & Pages States
  const [shopSettings, setShopSettings] = useState<ShopSettings | null>(propSettings || null);
  // Page counts for the recent jobs and the files waiting to upload.
  const { jobPageCounts, filePageCounts } = usePageCounts(
    recentJobs,
    selectedFiles,
    (jobId) => storageService.getFileUrl(shopSlug, jobId),
  );
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Sync shopSettings when prop changes (e.g. settings loaded asynchronously from server)
  useEffect(() => {
    if (propSettings) {
      setShopSettings(propSettings);
    }
  }, [propSettings]);

  // Fetch recent jobs, settings, and discount rules on mount and after upload
  useEffect(() => {
    (async () => {
      try {
        const [jobs, settings, rules] = await Promise.all([
          storageService.getMyRecentJobs(shopSlug),
          propSettings ? Promise.resolve(propSettings) : storageService.getSettings(shopSlug),
          storageService.getActiveDiscountRules(shopSlug),
        ]);
        setRecentJobs(jobs as PrintJob[]);
        if (!propSettings) setShopSettings(settings);
        setDiscountRules(rules);
      } catch (err) {
        console.error("Failed to load recent data", err);
      }
    })();
  }, [overallSuccess, shopSlug]);

  // Live status updates via SSE — cloud pushes { orderId, status } whenever
  // the local shop app calls /api/shop/status for one of our orders.
  useEffect(() => {
    if (recentJobs.length === 0) return;
    const ids = recentJobs.map((j) => j.id).filter(Boolean).join(",");
    if (!ids) return;
    const es = new EventSource(`/api/s/${shopSlug}/orders/stream?ids=${encodeURIComponent(ids)}`);
    es.addEventListener("status-change", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        const nextStatus = String(data.status || "").toUpperCase();
        setRecentJobs((prev) =>
          prev.map((j) => (j.id === data.orderId ? { ...j, status: nextStatus as PrintStatus } : j)),
        );
      } catch { /* ignored */ }
    });
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
  }, [recentJobs.map((j) => j.id).join(","), shopSlug]);

  // Logged-in customers: auto-fill name/phone and apply saved defaults once.
  // Never blocks or alters the guest flow — runs only when a session exists.
  useEffect(() => {
    if (!user || !accessToken || appliedProfileDefaults.current) return;
    (async () => {
      try {
        const profile = await storageService.getAccountProfile(accessToken);
        appliedProfileDefaults.current = true;
        setFormData((prev) => ({
          ...prev,
          name: prev.name || profile.name || "",
          phone: prev.phone || profile.phone || "",
        }));
        if (profile.defaultPaperTypeId || profile.defaultCopies) {
          setPrintPreferences((prev) => ({
            ...prev,
            paperType: profile.defaultPaperTypeId || prev.paperType,
            copies: profile.defaultCopies || prev.copies,
          }));
        }
      } catch (err) {
        console.error("Failed to load account profile", err);
      }
    })();
  }, [user, accessToken]);

  const handleCancelJob = (id: string) => {
    setCancelConfirm({ isOpen: true, jobId: id });
  };

  const confirmCancelJob = async () => {
    if (cancelConfirm.jobId) {
      try {
        await storageService.deleteJob(shopSlug, cancelConfirm.jobId);
        toast({ title: isRtl ? "تم إلغاء الطباعة بنجاح" : "Print job cancelled successfully", variant: "success" });
      } catch (err) {
        // deleteJob always drops the order from this browser's own tracking
        // (see storageService), even when the server-side delete fails —
        // otherwise an order whose file already disappeared from disk is
        // stuck in the list forever with no way to clear it.
        console.error("Failed to cancel job", err);
        toast({ title: isRtl ? "تمت إزالته من قائمتك" : "Removed from your list", variant: "success" });
      }
      setRecentJobs((prev) => prev.filter((job) => job.id !== cancelConfirm.jobId));
    }
    setCancelConfirm({ isOpen: false, jobId: null });
  };


  // A file's effective print preferences: the shared defaults, overridden
  // per-file when the customer customized that one (e.g. B&W for one file,
  // color for another).
  const getPreferencesForFile = (fileId?: string): UploadPrintPreferences => ({
    ...printPreferences,
    ...(fileId ? fileOverrides[fileId] : undefined),
  });

  // Prices shown under each picked file, discounts included.
  const getFilePriceWithDiscount = makeFilePriceCalculator(
    shopSettings,
    getPreferencesForFile,
    discountRules,
    filePageCounts,
  );

  const handlePreviewJob = async (job: PrintJob) => {
    try {
      const url = await storageService.getFileUrl(shopSlug, job.id);
      if (url) setPreviewJob({ job, url });
    } catch (err) {
      console.error("Failed to fetch preview", err);
    }
  };

  

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length > 0) {
      const newFileStatuses: FileStatus[] = [];
      let hasError = false;

      for (const file of files) {
        if (!ALLOWED_TYPES.includes(file.type)) {
          setError(t("fileLimit"));
          hasError = true;
          break;
        }
        newFileStatuses.push({
          file,
          progress: 0,
          status: "pending",
          id: generateSafeId(),
        });
      }

      if (!hasError) {
        setSelectedFiles((prev) => [...prev, ...newFileStatuses]);
        setError(null);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  };

  const removeFile = (id: string) => {
    if (isUploading) return;
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id));
    setFileOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const performUpload = async (
    fileStatus: FileStatus,
    name: string,
    phone: string,
    notes: string,
    orderId: string,
    signal: AbortSignal,
  ) => {
    // Include the price the customer just saw (with discounts applied) so the
    // server can persist it on the order — later reads don't need to refetch
    // shop settings just to recompute the same number.
    const priceInfo = getFilePriceWithDiscount(fileStatus.file, fileStatus.id);
    const quotedPrice = priceInfo ? priceInfo.final : null;
    const effectivePreferences = getPreferencesForFile(fileStatus.id);

    const job: PrintJob & { quotedPrice?: number | null } = {
      id: generateSafeId(),
      orderId,
      customerName: name.trim(),
      phoneNumber: phone.trim(),
      notes: notes.trim(),
      fileName: fileStatus.file.name,
      fileType: fileStatus.file.type,
      fileSize: fileStatus.file.size,
      uploadDate: new Date().toISOString(),
      status: PrintStatus.PENDING,
      printPreferences: {
        colorMode: effectivePreferences.colorMode,
        copies: effectivePreferences.copies,
        paperType: effectivePreferences.paperType,
      },
      quotedPrice,
    };

    setSelectedFiles((prev) =>
      prev.map((f) =>
        f.id === fileStatus.id ? { ...f, status: "uploading" } : f,
      ),
    );

    try {
      await storageService.saveJob(shopSlug, job, fileStatus.file, (progress) => {
        setSelectedFiles((prev) =>
          prev.map((f) => (f.id === fileStatus.id ? { ...f, progress } : f)),
        );
      }, accessToken, signal);
      setSelectedFiles((prev) =>
        prev.map((f) =>
          f.id === fileStatus.id
            ? { ...f, status: "success", progress: 100 }
            : f,
        ),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setSelectedFiles((prev) =>
          prev.map((f) =>
            f.id === fileStatus.id ? { ...f, status: "pending", progress: 0 } : f,
          ),
        );
        throw err;
      }
      console.error("Upload error for file:", fileStatus.file.name, err);
      setSelectedFiles((prev) =>
        prev.map((f) =>
          f.id === fileStatus.id ? { ...f, status: "error" } : f,
        ),
      );
      throw err;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFiles.length === 0) {
      setError(t("selectFile"));
      return;
    }

    setIsUploading(true);
    setError(null);

    // One id per submission, shared by every file in it, so the shop's admin
    // groups them as a single order even though each file uploads — and
    // lands on the server — at its own time.
    const orderId = generateSafeId();
    const controller = new AbortController();
    uploadAbortRef.current = controller;

    try {
      for (const fileStatus of selectedFiles) {
        if (fileStatus.status === "success") continue;
        await performUpload(
          fileStatus,
          formData.name,
          formData.phone,
          formData.notes,
          orderId,
          controller.signal,
        );
      }
      setOverallSuccess(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(t("errorMsg"));
      }
    } finally {
      setIsUploading(false);
      uploadAbortRef.current = null;
    }
  };

  const cancelUpload = () => {
    uploadAbortRef.current?.abort();
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const overallProgress = selectedFiles.length > 0
    ? Math.round(selectedFiles.reduce((sum, f) => sum + (f.status === "success" ? 100 : f.progress), 0) / selectedFiles.length)
    : 0;

  if (overallSuccess) {
    return (
      <>
        <style>{`
          @keyframes successPop {
            0% { transform: scale(0); opacity: 0; }
            60% { transform: scale(1.1); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
          }
          @keyframes fadeSlideUp {
            0% { opacity: 0; transform: translateY(12px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          .success-pop { animation: successPop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards; }
          .fade-slide-up { animation: fadeSlideUp 0.4s ease forwards; }
        `}</style>
        <div className="max-w-md mx-auto mt-12">
          <div className="bg-white dark:bg-gray-800 p-10 rounded-3xl shadow-2xl shadow-indigo-100/60 dark:shadow-indigo-900/30 text-center border border-gray-100 dark:border-gray-800">
            <div className="success-pop w-20 h-20 mx-auto mb-5">
              <div className="w-20 h-20 bg-green-500 dark:bg-green-600 rounded-full flex items-center justify-center shadow-lg shadow-green-200 dark:shadow-green-900/30">
                <Icon name="check" className="w-10 h-10 text-white" />
              </div>
            </div>

            <div className="fade-slide-up" style={{ animationDelay: "0.15s", opacity: 0 }}>
              <h2 className="text-2xl font-bold text-foreground mb-2">
                {isRtl ? "تم الإرسال!" : "Files Sent!"}
              </h2>
              <p className="text-muted-foreground mb-6 text-sm">
                {isRtl ? "وصلت ملفاتك إلى الطابعة بنجاح" : "Your files are on their way to the printer"}
              </p>
              <Button
                size="lg"
                className="w-full"
                onClick={() => {
                  setOverallSuccess(false);
                  setSelectedFiles([]);
                  setFileOverrides({});
                  setFormData({ name: "", phone: "", notes: "" });
                  setPrintPreferences({ colorMode: "color", copies: 1, paperType: shopSettings?.paperTypes?.[0]?.id || "normal" });
                }}
              >
                {isRtl ? "إرسال ملفات أخرى" : "Send more files"}
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-3 sm:px-4">
      <div className="text-center mb-5">
        <h1 className="text-xl sm:text-2xl font-bold text-foreground mb-1">
          {t("uploadTitle")}
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">{t("uploadSub")}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1">
          <Button variant="link" onClick={() => setShareQrOpen(true)} className="gap-2">
            <Icon name="sliders" className="w-4 h-4" />
            {isRtl ? "شارك الموقع" : "Share website"}
          </Button>
          {shopSettings && ((shopSettings.phoneNumbers?.length ?? 0) > 0 || shopSettings.email || shopSettings.address) && (
            <Button
              variant="link"
              onClick={() => setStoreInfoOpen(true)}
              className="gap-2"
            >
              <Icon name="building" className="w-4 h-4" />
              {isRtl ? "معلومات المحل" : "Store Info"}
            </Button>
          )}
          {/* The customer who would rather walk in than upload. Opens the
              shop's position in their own maps app — Google has the better
              road data for Algeria even though the embedded map is OSM. */}
          {shopSettings?.location && (
            <Button
              variant="link"
              className="gap-2"
              onClick={() =>
                window.open(directionsUrl(shopSettings.location) || "", "_blank", "noopener,noreferrer")
              }
            >
              <Icon name="map-pin" className="w-4 h-4" />
              {isRtl ? "الذهاب إلى المحل" : "Go to the shop"}
            </Button>
          )}
        </div>
      </div>

      <UploadForm
        t={t}
        isRtl={isRtl}
        shopSettings={shopSettings}
        formData={formData}
        setFormData={setFormData}
        printPreferences={printPreferences}
        setPrintPreferences={setPrintPreferences}
        fileOverrides={fileOverrides}
        setFileOverrides={setFileOverrides}
        filePageCounts={filePageCounts}
        selectedFiles={selectedFiles}
        setSelectedFiles={setSelectedFiles}
        removeFile={removeFile}
        handleFileChange={handleFileChange}
        handleSubmit={handleSubmit}
        isUploading={isUploading}
        isDragging={isDragging}
        setIsDragging={setIsDragging}
        error={error}
        setError={setError}
        fileInputRef={fileInputRef}
        cameraInputRef={cameraInputRef}
        isOfficeFile={isOfficeFile}
        getFilePriceWithDiscount={getFilePriceWithDiscount}
        formatSize={formatSize}
      />

      {/* Recent Uploads Section */}
      <RecentUploads
        t={t}
        isRtl={isRtl}
        recentJobs={recentJobs}
        shopSettings={shopSettings}
        discountRules={discountRules}
        jobPageCounts={jobPageCounts}
        isOfficeType={isOfficeType}
        handlePreviewJob={handlePreviewJob}
        handleCancelJob={handleCancelJob}
      />

      {/* The shop signs off the page: who they are, and where else to find
          them. Renders nothing when neither field is set. */}
      <StoreFooter isRtl={isRtl} shopSettings={shopSettings} />

      <ShareQrDialog
        open={shareQrOpen}
        onOpenChange={setShareQrOpen}
        lang={lang}
        shopSlug={shopSlug}
        shopSettings={shopSettings}
      />

      <UploadDialogs
        t={t}
        isRtl={isRtl}
        shopSettings={shopSettings}
        previewJob={previewJob}
        setPreviewJob={setPreviewJob}
        isUploading={isUploading}
        overallProgress={overallProgress}
        selectedFiles={selectedFiles}
        onCancelUpload={cancelUpload}
        cancelConfirm={cancelConfirm}
        setCancelConfirm={setCancelConfirm}
        confirmCancelJob={confirmCancelJob}
        storeInfoOpen={storeInfoOpen}
        setStoreInfoOpen={setStoreInfoOpen}
      />

      <Toaster />
    </div>
  );
};

export default UploadView;
