import React from "react";
import { PrintJob, PrintStatus, ShopSettings, DiscountRule } from "../../types";
import { calculatePrintPrice, formatPrice, calculateJobDiscount } from "../../pricing";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Card, CardContent } from "../ui/card";

export interface RecentUploadsProps {
  t: (key: string) => string;
  isRtl: boolean;
  recentJobs: PrintJob[];
  shopSettings: ShopSettings | null;
  discountRules: DiscountRule[];
  /** Page counts resolved after upload, keyed by job id. */
  jobPageCounts: Record<string, number>;
  isOfficeType: (mimeType: string) => boolean;
  handlePreviewJob: (job: PrintJob) => void;
  /** Called with the job id the customer asked to cancel. */
  handleCancelJob: (jobId: string) => void;
}

/**
 * "Your recent uploads" — status, price and the cancel/preview actions for the
 * jobs this browser has submitted.
 *
 * Identical in both apps: the desktop kiosk and the online portal show the
 * customer the same list, differing only in how the jobs were fetched.
 */
export const RecentUploads: React.FC<RecentUploadsProps> = ({
  t,
  isRtl,
  recentJobs,
  shopSettings,
  discountRules,
  jobPageCounts,
  isOfficeType,
  handlePreviewJob,
  handleCancelJob,
}) => {
  if (recentJobs.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg sm:text-xl font-bold text-foreground">
          {t("recentUploads")}
        </h2>
      </div>
      <div className="grid gap-2 sm:gap-3">
        {recentJobs.map((job) => (
          <Card key={job.id}>
            <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* File type icon */}
              <div className="w-7 h-7 sm:w-10 sm:h-10 rounded-full flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                {job.fileType.includes("pdf") ? (
                  <Icon name="file-doc" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : job.fileType.includes("word") || job.fileType.includes("document") ? (
                  <Icon name="file-doc" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : job.fileType.includes("excel") || job.fileType.includes("spreadsheet") ? (
                  <Icon name="file-doc" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : job.fileType.includes("image") ? (
                  <Icon name="file-image" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : (
                  <Icon name="file-doc" className="w-4 h-4 sm:w-5 sm:h-5" />
                )}
              </div>
              <div
                className={`w-7 h-7 sm:w-10 sm:h-10 rounded-full flex items-center justify-center shrink-0 ${job.status === PrintStatus.PRINTED
                  ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400"
                  : "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400"
                  }`}
              >
                {job.status === PrintStatus.PRINTED ? (
                  <Icon name="check" className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : (
                  <Icon name="clock" className="w-4 h-4 sm:w-5 sm:h-5" />
                )}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate max-w-[140px] sm:max-w-[240px] md:max-w-sm text-sm sm:text-base">
                  {job.fileName}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                  <p>
                    {new Date(job.uploadDate).toLocaleDateString(
                      isRtl ? "ar-EG" : "en-US",
                      { numberingSystem: "latn" },
                    )}
                  </p>
                  {jobPageCounts[job.id] && !isOfficeType(job.fileType) ? (
                    <>
                      <span className="w-1 h-1 rounded-full bg-gray-300 hidden sm:inline-block"></span>
                      <p className="flex items-center gap-1 font-medium bg-gray-100 dark:bg-gray-800/80 text-muted-foreground px-1.5 py-0.5 rounded text-xs sm:text-xs">
                        <Icon name="file-doc" className="w-3 h-3 text-muted-foreground" />
                        {jobPageCounts[job.id]} {isRtl ? "صفحات" : "Pages"}
                      </p>
                    </>
                  ) : null}
                  {job.printPreferences && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-gray-300 hidden sm:inline-block"></span>
                      <span className="flex items-center gap-1 text-xs sm:text-xs text-muted-foreground">
                        <Icon name="color" className="w-3 h-3" />
                        {job.printPreferences.colorMode === "blackWhite" ? (isRtl ? "أبيض وأسود" : "B&W") : (isRtl ? "ملون" : "Color")}
                      </span>
                      <span className="text-xs sm:text-xs text-muted-foreground">
                        {job.printPreferences.copies}x
                      </span>
                      <span className="text-xs sm:text-xs text-muted-foreground capitalize">
                        {(() => {
                          const pt = (shopSettings?.paperTypes || []).find(p => p.id === job.printPreferences?.paperType);
                          if (pt) return isRtl ? pt.nameAr : pt.name;
                          switch (job.printPreferences?.paperType) {
                            case "glossy": return isRtl ? "لامع" : "Glossy";
                            case "cardboard": return isRtl ? "مقوى" : "Cardboard";
                            default: return isRtl ? "عادي" : "Normal";
                          }
                        })()}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div className="flex items-center gap-2">
                {(shopSettings?.pricing || (shopSettings?.paperTypes && shopSettings.paperTypes.length > 0)) && !!jobPageCounts[job.id] && !isOfficeType(job.fileType) && (() => {
                  const basePrice = calculatePrintPrice(job, shopSettings, jobPageCounts[job.id] || 1).totalPrice;
                  const discountResult = calculateJobDiscount(job, basePrice, jobPageCounts[job.id] || 1, discountRules);
                  const hasDiscount = discountResult.discountAmount > 0;
                  return (
                    <span className={`text-sm font-black px-2.5 py-1 rounded-md border shadow-sm dark:shadow-gray-900/50 whitespace-nowrap tracking-tight ${hasDiscount ? "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/30" : "text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/20 border-green-200 dark:border-green-800/30"}`}>
                      {hasDiscount ? (
                        <span className="flex items-center gap-1.5">
                          <span className="line-through text-muted-foreground text-xs">{formatPrice(basePrice)}</span>
                          <span>{formatPrice(discountResult.finalAmount)}</span>
                          <span className="text-xs bg-green-200 dark:bg-green-800/40 text-green-800 dark:text-green-300 px-1 py-0.5 rounded">-{discountResult.discountAmount.toFixed(0)} DZD</span>
                        </span>
                      ) : (
                        formatPrice(basePrice)
                      )}
                    </span>
                  );
                })()}
                <span
                  className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${job.status === PrintStatus.PRINTED
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400"
                    }`}
                >
                  {job.status === PrintStatus.PRINTED
                    ? t("printed")
                    : t("pending")}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handlePreviewJob(job)}
                  title={isRtl ? "معاينة" : "Preview"}
                  className="p-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-600 dark:hover:text-indigo-400 text-gray-400 dark:text-gray-500 transition-colors"
                 aria-label={isRtl ? "معاينة" : "Preview"}>
                  <Icon name="eye" className="w-4 h-4" />
                </button>
                {job.status === PrintStatus.PENDING && (
                  <button
                    type="button"
                    onClick={() => handleCancelJob(job.id)}
                    title={isRtl ? "إلغاء طباعة" : "Cancel print"}
                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 text-gray-400 dark:text-gray-500 transition-colors"
                   aria-label={isRtl ? "إلغاء طباعة" : "Cancel print"}>
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        ))}
      </div>
      {shopSettings?.pricing && (
        <div className="p-3 bg-blue-50/50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-800/30 flex items-start gap-3 mt-4">
          <Icon name="info" className="w-5 h-5 text-blue-500 dark:text-blue-400 mt-0.5 shrink-0" />
          <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">
            {isRtl
              ? "ملاحظة: السعر المعروض تقريبي. قد يتغير السعر النهائي حسب إعدادات المتجر الفعلية وحجم وألوان المستند النهائية التي يتم طباعتها."
              : "Note: The estimated price is approximate. The final price may change slightly depending on the exact dimensions, color ink coverage, and store verification."}
          </p>
        </div>
      )}
    </div>
  );
};
