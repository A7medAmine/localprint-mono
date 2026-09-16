import React from "react";
import { PrintJob, ShopSettings } from "../../types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import PreviewModal from "../preview/PreviewModal";
import { toast } from "../ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { FileStatus } from "./UploadForm";
import { directionsUrl } from "../../geo";
import ShopMap from "../map/ShopMap";

export interface UploadDialogsProps {
  t: (key: string) => string;
  isRtl: boolean;
  shopSettings: ShopSettings | null;

  /** File preview the customer opened from their recent uploads. */
  previewJob: { job: PrintJob; url: string } | null;
  setPreviewJob: React.Dispatch<React.SetStateAction<{ job: PrintJob; url: string } | null>>;

  /** Progress overlay shown while files are on their way to the shop. */
  isUploading: boolean;
  overallProgress: number;
  selectedFiles: FileStatus[];

  /** "Cancel this print job?" confirmation. */
  cancelConfirm: { isOpen: boolean; jobId: string | null };
  setCancelConfirm: React.Dispatch<React.SetStateAction<{ isOpen: boolean; jobId: string | null }>>;
  confirmCancelJob: () => void;

  /** The shop's phone/email/address sheet. */
  storeInfoOpen: boolean;
  setStoreInfoOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Everything the upload page shows on top of itself: the file preview, the
 * upload progress overlay, the cancel confirmation and the shop-info sheet.
 *
 * Identical in both apps — only the surrounding page differs.
 */
export const UploadDialogs: React.FC<UploadDialogsProps> = ({
  t,
  isRtl,
  shopSettings,
  previewJob,
  setPreviewJob,
  isUploading,
  overallProgress,
  selectedFiles,
  cancelConfirm,
  setCancelConfirm,
  confirmCancelJob,
  storeInfoOpen,
  setStoreInfoOpen,
}) => {
  return (
    <>
      <PreviewModal
        open={previewJob !== null}
        onClose={() => setPreviewJob(null)}
        url={previewJob?.url ?? null}
        fileName={previewJob?.job.fileName ?? ""}
        fileType={previewJob?.job.fileType}
        fileSize={previewJob?.job.fileSize}
      />

      {/* Upload Overlay */}
      {isUploading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-in fade-in duration-200"
          style={{ background: "rgba(10,10,25,0.6)", backdropFilter: "blur(8px)" }}>
          <div className="bg-card rounded-2xl shadow-2xl p-6 w-full max-w-sm text-center animate-in zoom-in-95 duration-200">
            {/* Progress ring */}
            <div className="relative mx-auto mb-3 w-16 h-16">
              <svg className="w-16 h-16 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="#e0e7ff" strokeWidth="7" />
                <circle
                  cx="40" cy="40" r="34"
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray="214"
                  strokeDashoffset={Math.max(4, 214 - (214 * overallProgress / 100))}
                  style={{ transition: "stroke-dashoffset 0.5s cubic-bezier(0.4, 0, 0.2, 1)" }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-bold text-indigo-700 dark:text-indigo-400 transition-all duration-300">{overallProgress}%</span>
              </div>
            </div>

            <p className="text-sm font-semibold text-foreground mb-4">
              {isRtl ? "جاري الإرسال..." : "Uploading..."}
            </p>

            {/* Progress bar */}
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden mb-5 relative">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all duration-500 ease-out"
                style={{ width: `${Math.max(overallProgress, 4)}%` }}
              />
            </div>

            {/* File list (names + status only) */}
            <div className="space-y-1.5 text-start max-h-32 overflow-y-auto">
              {selectedFiles.map(f => (
                <div key={f.id} className="flex items-center gap-2">
                  {f.status === "success" ? (
                    <div className="w-3.5 h-3.5 rounded-full bg-green-500 dark:bg-green-600 flex items-center justify-center flex-shrink-0 animate-in fade-in duration-200">
                      <Icon name="check" className="w-2 h-2 text-white" />
                    </div>
                  ) : f.status === "uploading" ? (
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin flex-shrink-0" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-border flex-shrink-0" />
                  )}
                  <span className={`text-xs truncate ${f.status === "success" ? "text-green-700 dark:text-green-400 font-medium" : f.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-300"}`}>
                    {f.file.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={cancelConfirm.isOpen} onOpenChange={(open) => { if (!open) setCancelConfirm({ isOpen: false, jobId: null }); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "حذف هذا الملف؟" : "Delete this file?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? "سيتم حذف هذا الملف بشكل دائم. لا يمكن التراجع عن هذا الإجراء."
                : "This file will be permanently deleted. This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCancelJob} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isRtl ? "حذف" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Store Info Dialog */}
      <Dialog open={storeInfoOpen} onOpenChange={setStoreInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{shopSettings?.shopName || "Atba3li"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {shopSettings?.phoneNumbers && shopSettings.phoneNumbers.length > 0 && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "أرقام الهاتف" : "Phone Numbers"}</label>
                <div className="mt-1 space-y-2">
                  {shopSettings.phoneNumbers.map((num, i) => (
                    <div key={i} className="flex items-center justify-between bg-muted/40 rounded-lg px-3 py-2">
                      <span dir="ltr" className="text-sm text-foreground">{num}</span>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(num); toast({ title: isRtl ? "تم النسخ" : "Copied" }); }}
                        className="p-1.5 text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                        title={isRtl ? "نسخ" : "Copy"}
                       aria-label={isRtl ? "نسخ" : "Copy"}>
                        <Icon name="copy" className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {shopSettings?.email && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "البريد الإلكتروني" : "Email"}</label>
                <div className="mt-1 flex items-center justify-between bg-muted/40 rounded-lg px-3 py-2">
                  <span className="text-sm text-foreground">{shopSettings.email}</span>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(shopSettings.email!); toast({ title: isRtl ? "تم النسخ" : "Copied" }); }}
                    className="p-1.5 text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                    title={isRtl ? "نسخ" : "Copy"}
                   aria-label={isRtl ? "نسخ" : "Copy"}>
                    <Icon name="copy" className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
            {shopSettings?.address && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "العنوان" : "Address"}</label>
                <p className="mt-1 text-sm text-foreground">{shopSettings.address}</p>
              </div>
            )}
            {shopSettings?.location && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "الموقع" : "Location"}</label>
                {/* The map is the answer to "where exactly is this?"; the
                    address line above is often a district, not a door. */}
                <div className="mt-1 overflow-hidden rounded-lg border border-border">
                  <ShopMap
                    location={shopSettings.location}
                    title={shopSettings.shopName}
                    className="h-48 w-full"
                    fallback={
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        {isRtl ? "تعذر تحميل الخريطة." : "The map could not load."}
                      </p>
                    }
                  />
                </div>
                <a
                  href={directionsUrl(shopSettings.location) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <Icon name="map-pin" className="h-4 w-4" />
                  {isRtl ? "احصل على الاتجاهات" : "Get directions"}
                </a>
              </div>
            )}
            {shopSettings?.workingHours && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "ساعات العمل" : "Working Hours"}</label>
                <p className="mt-1 text-sm text-foreground">{shopSettings.workingHours}</p>
              </div>
            )}
            {shopSettings?.returnPolicy && (
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{isRtl ? "سياسة الإرجاع" : "Return Policy"}</label>
                <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">{shopSettings.returnPolicy}</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Toaster for notifications */}
    </>
  );
};
