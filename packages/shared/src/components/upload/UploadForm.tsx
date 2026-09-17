import React from "react";
import { ShopSettings } from "../../types";
import { ALLOWED_TYPES } from "../../constants";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Icon } from "../ui/icon";

/** One file the customer picked, with its upload progress. */
export interface FileStatus {
  file: File;
  progress: number;
  status: "pending" | "uploading" | "success" | "error";
  id: string;
}

export interface UploadFormData {
  name: string;
  phone: string;
  notes: string;
}

export interface UploadPrintPreferences {
  colorMode: "color" | "blackWhite";
  copies: number;
  paperType: string;
}

/** Per-file deviations from the shared default print preferences, keyed by file id. */
export type FilePrintOverrides = Record<string, Partial<UploadPrintPreferences>>;

/** What a price line under a file shows, once discounts are applied. */
export interface FilePriceInfo {
  original: number;
  discount: number;
  final: number;
  hasDiscount: boolean;
  ruleName?: string;
  pages: number;
}

// Id generator that works in non-secure contexts (HTTP over a LAN IP), where
// crypto.randomUUID is unavailable.
const generateSafeId = () => Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

export interface UploadFormProps {
  t: (key: string) => string;
  isRtl: boolean;
  shopSettings: ShopSettings | null;

  formData: UploadFormData;
  setFormData: React.Dispatch<React.SetStateAction<UploadFormData>>;
  printPreferences: UploadPrintPreferences;
  setPrintPreferences: React.Dispatch<React.SetStateAction<UploadPrintPreferences>>;
  fileOverrides: FilePrintOverrides;
  setFileOverrides: React.Dispatch<React.SetStateAction<FilePrintOverrides>>;
  filePageCounts: Record<string, number>;

  selectedFiles: FileStatus[];
  setSelectedFiles: React.Dispatch<React.SetStateAction<FileStatus[]>>;
  removeFile: (id: string) => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSubmit: (e: React.FormEvent) => void;

  isUploading: boolean;
  isDragging: boolean;
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;

  fileInputRef: React.RefObject<HTMLInputElement | null>;
  cameraInputRef: React.RefObject<HTMLInputElement | null>;

  isOfficeFile: (file: File) => boolean;
  getFilePriceWithDiscount: (file: File, fileId?: string) => FilePriceInfo | null;
  formatSize: (bytes: number) => string;
}

/**
 * The customer-facing upload form: contact fields, print preferences, the drop
 * zone, the picked-file list with per-file pricing, and the submit button.
 *
 * Both apps render exactly this form — the desktop app for a walk-in customer on
 * the shop's own machine, the online portal for a remote one. What differs is
 * what happens around it (auth, shop slug, live status), so the state and the
 * upload itself stay in each app's view and arrive here as props.
 */
export const UploadForm: React.FC<UploadFormProps> = ({
  t,
  isRtl,
  shopSettings,
  formData,
  setFormData,
  printPreferences,
  setPrintPreferences,
  fileOverrides,
  setFileOverrides,
  filePageCounts,
  selectedFiles,
  setSelectedFiles,
  removeFile,
  handleFileChange,
  handleSubmit,
  isUploading,
  isDragging,
  setIsDragging,
  error,
  setError,
  fileInputRef,
  cameraInputRef,
  isOfficeFile,
  getFilePriceWithDiscount,
  formatSize,
}) => {
  const [customizingFileId, setCustomizingFileId] = React.useState<string | null>(null);

  const effectivePreferences = (fileId: string): UploadPrintPreferences => ({
    ...printPreferences,
    ...fileOverrides[fileId],
  });

  const setFileOverride = <K extends keyof UploadPrintPreferences>(
    fileId: string,
    key: K,
    value: UploadPrintPreferences[K],
  ) => {
    setFileOverrides((prev) => ({
      ...prev,
      [fileId]: { ...prev[fileId], [key]: value },
    }));
  };

  const clearFileOverride = (fileId: string) => {
    setFileOverrides((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white dark:bg-gray-800 p-3 sm:p-6 lg:p-7 rounded-2xl shadow-xl shadow-indigo-100/40 dark:shadow-indigo-900/20 border border-white dark:border-gray-700 space-y-4 sm:space-y-5 mb-8"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <div>
          <label className="block text-sm font-semibold text-foreground mb-1">
            {t("customerName")}{" "}
            <span className="text-muted-foreground font-normal">
              ({isRtl ? "اختياري" : "Optional"})
            </span>
          </label>
          <Input
            disabled={isUploading}
            value={formData.name}
            onChange={(e) =>
              setFormData({ ...formData, name: e.target.value })
            }
            placeholder={isRtl ? "مثال: محمد علي" : "e.g. John Doe"}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-foreground mb-1">
            {t("phoneNumber")}{" "}
            <span className="text-muted-foreground font-normal">
              ({isRtl ? "اختياري" : "Optional"})
            </span>
          </label>
          <Input
            type="tel"
            disabled={isUploading}
            value={formData.phone}
            onChange={(e) =>
              setFormData({ ...formData, phone: e.target.value })
            }
            placeholder={"05xxxxxxxx"}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-1">
          {t("notes")}
        </label>
        <Textarea
          disabled={isUploading}
          value={formData.notes}
          onChange={(e) =>
            setFormData({ ...formData, notes: e.target.value })
          }
          placeholder={
            isRtl
              ? "أدخل تعليمات الطباعة الإضافية هنا..."
              : "Enter additional printing instructions here..."
          }
        />
      </div>

      {/* Print Preferences Section */}
      <div className="bg-muted/40 p-3 sm:p-6 rounded-2xl border border-border">
        <label className="block text-sm font-semibold text-foreground mb-3 sm:mb-4">
          {isRtl ? "تفضيلات الطباعة" : "Print Preferences"}
        </label>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {/* Color Mode */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              {isRtl ? "وضع الألوان" : "Color Mode"}
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={printPreferences.colorMode === "color" ? "default" : "outline"}
                disabled={isUploading}
                onClick={() =>
                  setPrintPreferences({
                    ...printPreferences,
                    colorMode: "color",
                  })
                }
                className="flex-1"
              >
                {isRtl ? "ملون" : "Color"}
              </Button>
              <Button
                type="button"
                variant={printPreferences.colorMode === "blackWhite" ? "default" : "outline"}
                disabled={isUploading}
                onClick={() =>
                  setPrintPreferences({
                    ...printPreferences,
                    colorMode: "blackWhite",
                  })
                }
                className="flex-1"
              >
                {isRtl ? "أبيض وأسود" : "B&W"}
              </Button>
            </div>
          </div>

          {/* Number of Copies */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              {isRtl ? "عدد النسخ" : "Number of Copies"}
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={isUploading || printPreferences.copies <= 1}
                        aria-label={isRtl ? "إنقاص عدد النسخ" : "Decrease copies"}
                onClick={() =>
                  setPrintPreferences({
                    ...printPreferences,
                    copies: Math.max(1, printPreferences.copies - 1),
                  })
                }
              >
                <Icon name="minus" className="w-4 h-4" />
              </Button>
              <Input
                type="number"
                min="1"
                max="100"
                disabled={isUploading}
                value={printPreferences.copies}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 1;
                  setPrintPreferences({
                    ...printPreferences,
                    copies: Math.max(1, Math.min(100, value)),
                  });
                }}
                className="flex-1 text-center"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={isUploading || printPreferences.copies >= 100}
                        aria-label={isRtl ? "زيادة عدد النسخ" : "Increase copies"}
                onClick={() =>
                  setPrintPreferences({
                    ...printPreferences,
                    copies: Math.min(100, printPreferences.copies + 1),
                  })
                }
              >
                <Icon name="plus" className="w-4 h-4" />
              </Button>
            </div>
          </div>
          </div>

          {/* Paper Type */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              {isRtl ? "نوع الورق" : "Paper Type"}
            </label>
            <div className="flex flex-wrap gap-2">
              {(shopSettings?.paperTypes && shopSettings.paperTypes.length > 0
                ? shopSettings.paperTypes
                : [
                    { id: "normal", name: "Normal", nameAr: "عادي" },
                    { id: "glossy", name: "Glossy", nameAr: "لامع" },
                    { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى" },
                  ]
              ).map((pt) => (
                <Button
                  key={pt.id}
                  type="button"
                  variant={printPreferences.paperType === pt.id ? "default" : "outline"}
                  disabled={isUploading}
                  onClick={() => setPrintPreferences({ ...printPreferences, paperType: pt.id })}
                  className="flex-1 min-w-[5rem]"
                >
                  {isRtl ? pt.nameAr : pt.name}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-foreground mb-2">
          {t("selectFile")}
        </label>

        {/* Hidden inputs — one for the file picker, one for the phone camera */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
          multiple
          accept=".pdf,.docx,.xlsx,.xls,.ppt,.pptx,.jpg,.jpeg,.png,image/jpeg,image/png"
        />
        <input
          type="file"
          ref={cameraInputRef}
          onChange={handleFileChange}
          className="hidden"
          accept="image/*"
          capture="environment"
        />

        <div
          role="group"
          aria-label={t("selectFile")}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            const files = Array.from(e.dataTransfer.files);
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
            }
          }}
          className={`rounded-xl border-2 border-dashed transition-colors ${
            isDragging
              ? "border-indigo-500 dark:border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20"
              : "border-border bg-gray-50/50 dark:bg-gray-900/30"
          }`}
        >
          <div className="p-4 sm:p-6 flex flex-col items-center gap-3 sm:gap-4">
            <Icon name="upload" className="w-10 h-10 sm:w-12 sm:h-12 text-muted-foreground" />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-sm">
              <Button
                type="button"
                size="lg"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-12 gap-2"
              >
                <Icon name="folder" className="w-5 h-5" />
                {isRtl ? "اختر ملفات" : "Choose files"}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={isUploading}
                onClick={() => cameraInputRef.current?.click()}
                className="w-full h-12 gap-2"
              >
                <Icon name="camera" className="w-5 h-5" />
                {isRtl ? "التقط صورة" : "Take photo"}
              </Button>
            </div>

            <p className="hidden sm:block text-xs text-muted-foreground">
              {isRtl ? "أو اسحب الملفات هنا" : "Or drop files here"}
            </p>
            <p className="text-xs sm:text-xs text-center text-muted-foreground leading-snug">
              {t("fileLimit")}
            </p>
          </div>
        </div>
      </div>

      {selectedFiles.length > 0 && (
        <div className="space-y-3 mt-4">
          <h3 className="text-sm font-bold text-foreground">
            {isRtl ? "الملفات المختارة" : "Selected Files"} (
            {selectedFiles.length})
          </h3>
          {selectedFiles.map((fileStatus) => (
            <div
              key={fileStatus.id}
              className="bg-muted/40 border border-border rounded-lg p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
                  <Icon name="file-doc" className="w-4 h-4 sm:w-5 sm:h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs sm:text-sm font-medium text-foreground break-words leading-snug">
                      {fileStatus.file.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2">
                      <span>{formatSize(fileStatus.file.size)}</span>
                      {filePageCounts[fileStatus.id] > 0 && (
                        <span>
                          {filePageCounts[fileStatus.id]} {isRtl ? "صفحة" : filePageCounts[fileStatus.id] === 1 ? "page" : "pages"}
                        </span>
                      )}
                      {(() => {
                        const priceInfo = getFilePriceWithDiscount(fileStatus.file, fileStatus.id);
                        if (priceInfo === null && isOfficeFile(fileStatus.file)) {
                          return <span className="text-red-500 dark:text-red-400 text-xs">{isRtl ? "لا يمكن حساب الصفحات" : "Can't count pages"}</span>;
                        }
                        if (!priceInfo) return null;
                        return priceInfo.hasDiscount ? (
                          <span className="text-green-600 dark:text-green-400 font-medium text-xs">
                            <span className="line-through text-muted-foreground me-1">{priceInfo.original.toFixed(0)} DZD</span>
                            {priceInfo.final.toFixed(0)} DZD
                            <span className="text-xs ms-0.5">(-{priceInfo.discount.toFixed(0)})</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{priceInfo.original.toFixed(0)} DZD</span>
                        );
                      })()}
                      {fileOverrides[fileStatus.id] && (
                        <span className="text-indigo-600 dark:text-indigo-400 font-medium">
                          {isRtl ? "مخصص" : "Custom"}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {!isUploading && fileStatus.status !== "success" && (
                    <button
                      type="button"
                      onClick={() =>
                        setCustomizingFileId((prev) => (prev === fileStatus.id ? null : fileStatus.id))
                      }
                      className={`p-1 -m-1 ${customizingFileId === fileStatus.id ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400 dark:text-gray-500 hover:text-indigo-600 dark:hover:text-indigo-400"}`}
                      aria-label={isRtl ? "تخصيص هذا الملف" : "Customize this file"}
                      title={isRtl ? "خيارات طباعة خاصة بهذا الملف" : "Print options for this file"}
                    >
                      <Icon name="sliders" className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                  )}
                  {!isUploading && fileStatus.status !== "success" && (
                    <button
                      type="button"
                      onClick={() => removeFile(fileStatus.id)}
                      className="text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 p-1 -m-1"
                      aria-label="Remove file"
                    >
                      <Icon name="x" className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                  )}
                  {fileStatus.status === "success" && (
                    <Icon name="check" className="w-4 h-4 sm:w-5 sm:h-5 text-green-500 dark:text-green-400 mt-0.5" />
                  )}
                  {fileStatus.status === "error" && (
                    <Icon name="alert-circle" className="w-4 h-4 sm:w-5 sm:h-5 text-red-500 dark:text-red-400 mt-0.5" />
                  )}
                </div>
              </div>
              {fileStatus.status === "uploading" && (
                <div className="w-full bg-muted rounded-full h-1.5 mt-2 overflow-hidden">
                  <div
                    className="bg-indigo-600 h-1.5 transition-all duration-300"
                    style={{ width: `${fileStatus.progress}%` }}
                  />
                </div>
              )}
              {customizingFileId === fileStatus.id && (
                <div className="mt-3 pt-3 border-t border-border space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        {isRtl ? "وضع الألوان" : "Color Mode"}
                      </label>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={effectivePreferences(fileStatus.id).colorMode === "color" ? "default" : "outline"}
                          onClick={() => setFileOverride(fileStatus.id, "colorMode", "color")}
                          className="flex-1"
                        >
                          {isRtl ? "ملون" : "Color"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={effectivePreferences(fileStatus.id).colorMode === "blackWhite" ? "default" : "outline"}
                          onClick={() => setFileOverride(fileStatus.id, "colorMode", "blackWhite")}
                          className="flex-1"
                        >
                          {isRtl ? "أبيض وأسود" : "B&W"}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        {isRtl ? "عدد النسخ" : "Copies"}
                      </label>
                      <Input
                        type="number"
                        min="1"
                        max="100"
                        value={effectivePreferences(fileStatus.id).copies}
                        onChange={(e) => {
                          const value = parseInt(e.target.value) || 1;
                          setFileOverride(fileStatus.id, "copies", Math.max(1, Math.min(100, value)));
                        }}
                        className="text-center"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                      {isRtl ? "نوع الورق" : "Paper Type"}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {(shopSettings?.paperTypes && shopSettings.paperTypes.length > 0
                        ? shopSettings.paperTypes
                        : [
                            { id: "normal", name: "Normal", nameAr: "عادي" },
                            { id: "glossy", name: "Glossy", nameAr: "لامع" },
                            { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى" },
                          ]
                      ).map((pt) => (
                        <Button
                          key={pt.id}
                          type="button"
                          size="sm"
                          variant={effectivePreferences(fileStatus.id).paperType === pt.id ? "default" : "outline"}
                          onClick={() => setFileOverride(fileStatus.id, "paperType", pt.id)}
                          className="flex-1 min-w-[5rem]"
                        >
                          {isRtl ? pt.nameAr : pt.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {fileOverrides[fileStatus.id] && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => clearFileOverride(fileStatus.id)}
                      className="text-muted-foreground"
                    >
                      {isRtl ? "استخدام الإعدادات الافتراضية" : "Reset to default"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Total Price Summary with Discounts */}
          {selectedFiles.length > 0 && shopSettings?.pricing && (
            <div className="mt-4 p-3 sm:p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/30 rounded-xl">
              {(() => {
                let totalOriginal = 0;
                let totalDiscount = 0;
                let totalFinal = 0;
                let totalPages = 0;

                selectedFiles.forEach((fileStatus) => {
                  const priceInfo = getFilePriceWithDiscount(fileStatus.file, fileStatus.id);
                  if (priceInfo) {
                    totalOriginal += priceInfo.original;
                    totalDiscount += priceInfo.discount;
                    totalFinal += priceInfo.final;
                    totalPages += priceInfo.pages;
                  }
                });

                const hasDiscount = totalDiscount > 0;

                return (
                  <div className="space-y-2">
                    {totalPages > 0 && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">
                          {isRtl ? "إجمالي الصفحات" : "Total pages"}
                        </span>
                        <span className="font-semibold text-foreground">{totalPages}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        {isRtl ? "المجموع الفرعي" : "Subtotal"}
                      </span>
                      <span className="font-semibold text-foreground">
                        {totalOriginal.toFixed(0)} DZD
                      </span>
                    </div>
                    {hasDiscount && (
                      <div className="flex justify-between items-center text-green-600 dark:text-green-400">
                        <span className="text-sm">
                          {isRtl ? "الخصم" : "Discount"}
                        </span>
                        <span className="font-semibold">
                          -{totalDiscount.toFixed(0)} DZD
                        </span>
                      </div>
                    )}
                    <div className="border-t border-indigo-200 pt-2 flex justify-between items-center">
                      <span className="text-base font-bold text-foreground">
                        {isRtl ? "الإجمالي" : "Total"}
                      </span>
                      <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">
                        {totalFinal.toFixed(0)} DZD
                      </span>
                    </div>
                    {hasDiscount && (
                      <p className="text-xs text-green-600 dark:text-green-400 text-center mt-2">
                        {isRtl
                          ? `وفرت ${totalDiscount.toFixed(0)} DZD!`
                          : `You saved ${totalDiscount.toFixed(0)} DZD!`}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs sm:text-sm border border-red-100 dark:border-red-800/30 leading-relaxed">
          {error}
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        disabled={isUploading || selectedFiles.length === 0}
        className="w-full gap-2 text-base sm:text-lg py-3 sm:py-4 shadow-xl shadow-indigo-600/20 dark:shadow-indigo-400/20"
      >
        {isUploading ? (
          <Icon name="spinner" className="animate-spin h-5 w-5" />
        ) : (
          <>
            <Icon name="upload" className="w-5 h-5" />
            {t("uploadBtn")}
          </>
        )}
      </Button>
    </form>
  );
};
