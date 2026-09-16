import React, { useState, useRef, useEffect } from "react";
import { Language, PrintJob, PrintStatus, ShopSettings, DiscountRule } from "../types";
import { TRANSLATIONS, ALLOWED_TYPES } from "../constants";
import { storageService } from "../services/storageService";
import QrPosterDialog from "../components/QrPosterDialog";
import { toast } from "../components/ui/use-toast";
import { Toaster } from "../components/ui/toaster";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { UploadForm } from "@localprint/shared/components/upload/UploadForm";
import { RecentUploads } from "@localprint/shared/components/upload/RecentUploads";
import { UploadDialogs } from "@localprint/shared/components/upload/UploadDialogs";
import {
  isOfficeFile,
  isOfficeType,
  makeFilePriceCalculator,
  usePageCounts,
} from "@localprint/shared/lib/useUploadPricing";

interface UploadViewProps {
  lang: Language;
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

const UploadView: React.FC<UploadViewProps> = ({ lang, shopSettings: propSettings }) => {
  const t = (key: string) => TRANSLATIONS[key][lang] || key;
  const isRtl = lang === "ar";
  // toast() imported from use-toast, called directly

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
  const [selectedFiles, setSelectedFiles] = useState<FileStatus[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [overallSuccess, setOverallSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<PrintJob[]>([]);
  const [showQrCode, setShowQrCode] = useState(false);

  // Preview States
  const [previewJob, setPreviewJob] = useState<{ job: PrintJob; url: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Pricing & Pages States
  const [shopSettings, setShopSettings] = useState<ShopSettings | null>(propSettings || null);
  // Page counts for the recent jobs and the files waiting to upload.
  const { jobPageCounts, filePageCounts } = usePageCounts(
    recentJobs,
    selectedFiles,
    (jobId) => storageService.getFileUrl(jobId),
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
          storageService.getMyRecentJobs(),
          propSettings ? Promise.resolve(propSettings) : storageService.getSettings(),
          storageService.getActiveDiscountRules(),
        ]);
        setRecentJobs(jobs as PrintJob[]);
        if (!propSettings) setShopSettings(settings);
        setDiscountRules(rules);
      } catch (err) {
        console.error("Failed to load recent data", err);
      }
    })();
  }, [overallSuccess]);

  const handleCancelJob = (id: string) => {
    setCancelConfirm({ isOpen: true, jobId: id });
  };

  const confirmCancelJob = async () => {
    if (cancelConfirm.jobId) {
      try {
        await storageService.deleteJob(cancelConfirm.jobId);
        setRecentJobs((prev) => prev.filter((job) => job.id !== cancelConfirm.jobId));
        toast({ title: isRtl ? "تم إلغاء الطباعة بنجاح" : "Print job cancelled successfully", variant: "success" });
      } catch (err) {
        console.error("Failed to cancel job", err);
        toast({ title: isRtl ? "فشل إلغاء الطباعة" : "Failed to cancel print job", variant: "destructive" });
      }
    }
    setCancelConfirm({ isOpen: false, jobId: null });
  };


  // Prices shown under each picked file, discounts included.
  const getFilePriceWithDiscount = makeFilePriceCalculator(
    shopSettings,
    printPreferences,
    discountRules,
    filePageCounts,
  );

  const handlePreviewJob = async (job: PrintJob) => {
    try {
      const url = await storageService.getFileUrl(job.id);
      if (url) setPreviewJob({ job, url });
    } catch (err) {
      console.error("Failed to fetch preview", err);
    }
  };

  const generateQRCode = () => setShowQrCode(true);

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
    }
  };

  const removeFile = (id: string) => {
    if (isUploading) return;
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const performUpload = async (
    fileStatus: FileStatus,
    name: string,
    phone: string,
    notes: string,
  ) => {
    const job: PrintJob = {
      id: generateSafeId(),
      customerName: name.trim(),
      phoneNumber: phone.trim(),
      notes: notes.trim(),
      fileName: fileStatus.file.name,
      fileType: fileStatus.file.type,
      fileSize: fileStatus.file.size,
      uploadDate: new Date().toISOString(),
      status: PrintStatus.PENDING,
      printPreferences: {
        colorMode: printPreferences.colorMode,
        copies: printPreferences.copies,
        paperType: printPreferences.paperType,
      },
    };

    setSelectedFiles((prev) =>
      prev.map((f) =>
        f.id === fileStatus.id ? { ...f, status: "uploading" } : f,
      ),
    );

    try {
      await storageService.saveJob(job, fileStatus.file, (progress) => {
        setSelectedFiles((prev) =>
          prev.map((f) => (f.id === fileStatus.id ? { ...f, progress } : f)),
        );
      });
      setSelectedFiles((prev) =>
        prev.map((f) =>
          f.id === fileStatus.id
            ? { ...f, status: "success", progress: 100 }
            : f,
        ),
      );
    } catch (err) {
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

    try {
      for (const fileStatus of selectedFiles) {
        if (fileStatus.status === "success") continue;
        await performUpload(
          fileStatus,
          formData.name,
          formData.phone,
          formData.notes,
        );
      }
      setOverallSuccess(true);
    } catch {
      setError(t("errorMsg"));
    } finally {
      setIsUploading(false);
    }
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
    <div className="w-full max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="text-center mb-5">
        <h1 className="text-xl sm:text-2xl font-bold text-foreground mb-1">
          {t("uploadTitle")}
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">{t("uploadSub")}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1">
          <Button
            variant="link"
            onClick={generateQRCode}
            className="gap-2"
          >
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

      <QrPosterDialog
        open={showQrCode}
        onOpenChange={setShowQrCode}
        lang={lang}
        shopSettings={shopSettings}
        shareOnly
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
