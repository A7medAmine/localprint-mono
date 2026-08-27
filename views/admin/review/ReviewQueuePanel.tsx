import React, { useState } from "react";
import { PrintJob } from "../../../types";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
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
import { Card, CardContent } from "../../../components/ui/card";
import { useAdmin } from "../AdminContext";

interface ReviewQueuePanelProps {
  reviewJobs: PrintJob[];
  /** Refresh the parent job list after an accept / reject. */
  onRefresh: () => void;
  onPreview: (job: PrintJob) => void;
}

const ReviewQueuePanel: React.FC<ReviewQueuePanelProps> = ({ reviewJobs, onRefresh, onPreview }) => {
  const { isRtl } = useAdmin();

  const [rejectDialogJob, setRejectDialogJob] = useState<PrintJob | null>(null);
  const [rejectReason, setRejectReason] = useState("bad_file");
  const [rejectNote, setRejectNote] = useState("");
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [acceptingReviewId, setAcceptingReviewId] = useState<string | null>(null);

  const handleAcceptReview = async (job: PrintJob) => {
    setAcceptingReviewId(job.id);
    try {
      await storageService.acceptReviewJob(job.id);
      toast({ title: isRtl ? "تم قبول الطلب" : "Job accepted", variant: "success" });
      onRefresh();
    } catch (err) {
      toast({ title: isRtl ? "فشل قبول الطلب" : "Failed to accept job", variant: "destructive" });
    } finally {
      setAcceptingReviewId(null);
    }
  };

  const handleSubmitReject = async () => {
    if (!rejectDialogJob) return;
    setRejectSubmitting(true);
    try {
      await storageService.rejectReviewJob(rejectDialogJob.id, rejectReason, rejectNote.trim() || undefined);
      toast({ title: isRtl ? "تم رفض الطلب" : "Job rejected", variant: "success" });
      setRejectDialogJob(null);
      onRefresh();
    } catch (err) {
      toast({ title: isRtl ? "فشل رفض الطلب" : "Failed to reject job", variant: "destructive" });
    } finally {
      setRejectSubmitting(false);
    }
  };

  return (
    <>
      <div className="max-w-5xl mx-auto space-y-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {isRtl ? "مراجعة الطلبات" : "Job Review"}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isRtl
              ? "طلبات وصلت من رابط الرفع الإلكتروني وتنتظر قبولك أو رفضك."
              : "Orders that came in from the online upload link, awaiting your decision."}
          </p>
        </div>

        {reviewJobs.length === 0 ? (
          <div className="px-6 py-14 sm:py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="max-w-sm mx-auto flex flex-col items-center text-center">
              <div className="relative w-36 h-36 sm:w-44 sm:h-44 mb-5">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-100 via-emerald-100 to-transparent dark:from-amber-500/10 dark:via-emerald-500/10 dark:to-transparent rounded-full blur-2xl" />
                <svg viewBox="0 0 200 200" className="relative w-full h-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <defs>
                    <linearGradient id="rvTray" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#fef3c7" />
                      <stop offset="100%" stopColor="#fde68a" />
                    </linearGradient>
                  </defs>
                  <ellipse cx="100" cy="170" rx="66" ry="8" fill="currentColor" className="text-gray-200 dark:text-gray-900/60" />
                  <path d="M40 110 h120 l-10 46 a6 6 0 0 1 -6 5 h-88 a6 6 0 0 1 -6 -5 z" fill="url(#rvTray)" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M40 110 h120 v-4 a4 4 0 0 0 -4 -4 h-112 a4 4 0 0 0 -4 4 z" fill="#fbbf24" />
                  <g>
                    <circle cx="100" cy="78" r="26" fill="#d1fae5" stroke="#10b981" strokeWidth="2" />
                    <path d="M88 78 l8 8 l16 -18" stroke="#059669" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </g>
                  <g>
                    <path d="M52 54 l3 -3 M52 54 l3 3 M52 54 l-3 3 M52 54 l-3 -3" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round">
                      <animateTransform attributeName="transform" type="rotate" from="0 52 54" to="360 52 54" dur="9s" repeatCount="indefinite" />
                    </path>
                    <circle cx="150" cy="46" r="2.5" fill="#34d399" />
                    <circle cx="160" cy="70" r="2" fill="#fbbf24" opacity="0.8" />
                    <circle cx="34" cy="88" r="2" fill="#f472b6" opacity="0.8" />
                  </g>
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {isRtl ? "لا شيء للمراجعة" : "Inbox zero"}
              </h3>
              <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {isRtl
                  ? "لا توجد طلبات بانتظار المراجعة. أحسنت — كل شيء تحت السيطرة."
                  : "No jobs awaiting review. Nice work — you're all caught up."}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {reviewJobs.map((job) => {
              const isOffice =
                job.fileType?.includes("word") ||
                job.fileType?.includes("document") ||
                job.fileType?.includes("excel") ||
                job.fileType?.includes("spreadsheet") ||
                job.fileType?.includes("presentation") ||
                job.fileType?.includes("powerpoint");
              return (
                <Card key={job.id}>
                  <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{job.fileName}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mt-1">
                          {job.customerName && <span>{job.customerName}</span>}
                          {job.phoneNumber && <span dir="ltr">{job.phoneNumber}</span>}
                          <span>{new Date(job.uploadDate).toLocaleString(isRtl ? "ar-EG" : "en-US", { numberingSystem: "latn" })}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                            {job.printPreferences?.colorMode === "blackWhite" ? (isRtl ? "أبيض وأسود" : "B&W") : (isRtl ? "ملون" : "Color")}
                          </span>
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                            {job.printPreferences?.copies || 1}x
                          </span>
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 capitalize">
                            {job.printPreferences?.paperType || "normal"}
                          </span>
                          {job.notes && (
                            <span className="text-[11px] text-gray-400 dark:text-gray-500 italic truncate max-w-[200px]">"{job.notes}"</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!isOffice && (
                        <Button variant="ghost" size="icon" onClick={() => onPreview(job)} title={isRtl ? "معاينة" : "Preview"} className="text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-white/10 w-9 h-9">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acceptingReviewId === job.id}
                        onClick={() => handleAcceptReview(job)}
                        className="text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20"
                      >
                        {isRtl ? "قبول" : "Accept"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setRejectDialogJob(job); setRejectReason("bad_file"); setRejectNote(""); }}
                        className="text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        {isRtl ? "رفض" : "Reject"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Reject Review Job Dialog */}
      <Dialog open={rejectDialogJob !== null} onOpenChange={(open) => { if (!open) setRejectDialogJob(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isRtl ? "رفض الطلب" : "Reject job"}</DialogTitle>
            <DialogDescription>
              {isRtl
                ? "سيتم إخبار العميل بسبب الرفض وحذف الملف. لا يمكن التراجع عن هذا الإجراء."
                : "The customer will be shown the reason and the file will be deleted. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                {isRtl ? "السبب" : "Reason"}
              </label>
              <Select value={rejectReason} onValueChange={setRejectReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bad_file">{isRtl ? "ملف تالف" : "Bad file"}</SelectItem>
                  <SelectItem value="wrong_format">{isRtl ? "صيغة غير مدعومة" : "Wrong format"}</SelectItem>
                  <SelectItem value="unreadable">{isRtl ? "غير قابل للقراءة" : "Unreadable"}</SelectItem>
                  <SelectItem value="other">{isRtl ? "أخرى" : "Other"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                {isRtl ? "ملاحظة (اختياري)" : "Note (optional)"}
              </label>
              <Textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder={isRtl ? "تفاصيل إضافية للعميل..." : "Extra detail for the customer..."}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogJob(null)} disabled={rejectSubmitting}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button
              onClick={handleSubmitReject}
              disabled={rejectSubmitting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {rejectSubmitting ? (isRtl ? "جارٍ الرفض..." : "Rejecting...") : (isRtl ? "رفض الطلب" : "Reject job")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ReviewQueuePanel;
