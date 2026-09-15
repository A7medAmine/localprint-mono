import React, { useMemo, useState } from "react";
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
import BlockUploaderDialog from "./BlockUploaderDialog";
import BlockedUploadersDialog from "./BlockedUploadersDialog";

interface ReviewQueuePanelProps {
  reviewJobs: PrintJob[];
  /** Refresh the parent job list after an accept / reject. */
  onRefresh: () => void;
  onPreview: (job: PrintJob) => void;
}

interface SenderGroup {
  key: string;
  customerName: string;
  phoneNumber: string;
  jobs: PrintJob[];
}

/**
 * Group the review queue by who sent it. Mirrors the job list's grouping key
 * (name + phone) so the same customer reads the same way in both panels;
 * uploads with neither name nor phone fall back to a per-minute bucket so one
 * anonymous batch still lands in a single group.
 */
const groupBySender = (jobs: PrintJob[]): SenderGroup[] => {
  const byKey = new Map<string, SenderGroup>();
  for (const job of jobs) {
    const name = job.customerName?.trim() || "";
    const phone = job.phoneNumber?.trim() || "";
    let key = `${name}-${phone}`;
    if (!name && !phone) key = `anon-${new Date(job.uploadDate).toISOString().slice(0, 16)}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, customerName: name, phoneNumber: phone, jobs: [] };
      byKey.set(key, group);
    }
    group.jobs.push(job);
  }
  return [...byKey.values()];
};

const ReviewQueuePanel: React.FC<ReviewQueuePanelProps> = ({ reviewJobs, onRefresh, onPreview }) => {
  const { isRtl } = useAdmin();

  const [rejectDialogJob, setRejectDialogJob] = useState<PrintJob | null>(null);
  const [rejectReason, setRejectReason] = useState("bad_file");
  const [rejectNote, setRejectNote] = useState("");
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [acceptingReviewId, setAcceptingReviewId] = useState<string | null>(null);
  // Group key currently being bulk-accepted, or "__all__" for the whole queue.
  const [bulkAcceptingKey, setBulkAcceptingKey] = useState<string | null>(null);
  // Batch awaiting the "reject all" confirmation, and the one being rejected.
  const [rejectAllTarget, setRejectAllTarget] = useState<{ key: string; label: string; jobs: PrintJob[] } | null>(null);
  const [bulkRejectingKey, setBulkRejectingKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Sender being blocked, and the blocklist manager.
  const [blockJob, setBlockJob] = useState<PrintJob | null>(null);
  const [blocklistOpen, setBlocklistOpen] = useState(false);

  const groups = useMemo(() => groupBySender(reviewJobs), [reviewJobs]);
  const busy = acceptingReviewId !== null || bulkAcceptingKey !== null || bulkRejectingKey !== null;

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

  /**
   * Accept a batch one job at a time. Sequential on purpose: each accept also
   * acks the order on the cloud, so firing a whole group in parallel would
   * burst that endpoint. One failure does not abort the rest — the summary
   * toast reports how many made it through.
   */
  const handleAcceptMany = async (key: string, jobs: PrintJob[]) => {
    if (jobs.length === 0) return;
    setBulkAcceptingKey(key);
    let accepted = 0;
    const failed: string[] = [];
    try {
      for (const job of jobs) {
        try {
          await storageService.acceptReviewJob(job.id);
          accepted++;
        } catch (err) {
          failed.push(job.fileName);
        }
      }
      if (failed.length === 0) {
        toast({
          title: isRtl
            ? `تم قبول ${accepted} طلب`
            : `Accepted ${accepted} job${accepted === 1 ? "" : "s"}`,
          variant: "success",
        });
      } else {
        toast({
          title: isRtl
            ? `تم قبول ${accepted}، وفشل ${failed.length}`
            : `Accepted ${accepted}, ${failed.length} failed`,
          description: failed.slice(0, 3).join(", "),
          variant: "destructive",
        });
      }
    } finally {
      setBulkAcceptingKey(null);
      onRefresh();
    }
  };

  /**
   * Reject a batch after the confirmation modal. Sequential for the same reason
   * accepts are, and deliberately reason-less: bulk rejects are a cleanup
   * action, so the cloud gets the generic "other" reason with no note.
   */
  const handleRejectMany = async () => {
    const target = rejectAllTarget;
    if (!target || target.jobs.length === 0) return;
    setBulkRejectingKey(target.key);
    setRejectAllTarget(null);
    let rejected = 0;
    const failed: string[] = [];
    try {
      for (const job of target.jobs) {
        try {
          await storageService.rejectReviewJob(job.id, "other");
          rejected++;
        } catch (err) {
          failed.push(job.fileName);
        }
      }
      if (failed.length === 0) {
        toast({
          title: isRtl
            ? `تم رفض ${rejected} طلب`
            : `Rejected ${rejected} job${rejected === 1 ? "" : "s"}`,
          variant: "success",
        });
      } else {
        toast({
          title: isRtl
            ? `تم رفض ${rejected}، وفشل ${failed.length}`
            : `Rejected ${rejected}, ${failed.length} failed`,
          description: failed.slice(0, 3).join(", "),
          variant: "destructive",
        });
      }
    } finally {
      setBulkRejectingKey(null);
      onRefresh();
    }
  };

  /** Pull the cloud queue now instead of waiting for the next poll tick. */
  const handleCheckForOrders = async () => {
    setChecking(true);
    try {
      const imported = await storageService.pollCloudOrders();
      toast({
        title:
          imported > 0
            ? (isRtl
                ? `تم استيراد ${imported} طلب جديد`
                : `Imported ${imported} new order${imported === 1 ? "" : "s"}`)
            : (isRtl ? "لا توجد طلبات جديدة" : "No new orders"),
        variant: "success",
      });
      onRefresh();
    } catch (err: any) {
      toast({
        title: isRtl ? "فشل التحقق من الطلبات" : "Failed to check for orders",
        description: err?.message,
        variant: "destructive",
      });
    } finally {
      setChecking(false);
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
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {isRtl ? "مراجعة الطلبات" : "Job Review"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isRtl
                ? "طلبات وصلت من رابط الرفع الإلكتروني وتنتظر قبولك أو رفضك."
                : "Orders that came in from the online upload link, awaiting your decision."}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setBlocklistOpen(true)}>
              {isRtl ? "المحظورون" : "Blocked"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCheckForOrders} disabled={checking}>
              <svg
                className={`w-4 h-4 ${"me-1.5"} ${checking ? "animate-spin" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {checking
                ? (isRtl ? "جارٍ التحقق..." : "Checking...")
                : (isRtl ? "التحقق من الطلبات" : "Check for orders")}
            </Button>
            {reviewJobs.length > 0 && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => handleAcceptMany("__all__", reviewJobs)}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {bulkAcceptingKey === "__all__"
                  ? (isRtl ? "جارٍ القبول..." : "Accepting...")
                  : (isRtl
                      ? `قبول الكل (${reviewJobs.length})`
                      : `Accept all (${reviewJobs.length})`)}
              </Button>
            )}
            {reviewJobs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setRejectAllTarget({
                    key: "__all__",
                    label: isRtl ? "كل الطلبات" : "the whole queue",
                    jobs: reviewJobs,
                  })
                }
                className="text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                {bulkRejectingKey === "__all__"
                  ? (isRtl ? "جارٍ الرفض..." : "Rejecting...")
                  : (isRtl
                      ? `رفض الكل (${reviewJobs.length})`
                      : `Reject all (${reviewJobs.length})`)}
              </Button>
            )}
          </div>
        </div>

        {reviewJobs.length === 0 ? (
          <div className="px-6 py-14 sm:py-16 bg-card rounded-xl border border-border overflow-hidden">
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
              <h3 className="text-lg font-semibold text-foreground">
                {isRtl ? "لا شيء للمراجعة" : "Inbox zero"}
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {isRtl
                  ? "لا توجد طلبات بانتظار المراجعة. أحسنت — كل شيء تحت السيطرة."
                  : "No jobs awaiting review. Nice work — you're all caught up."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => {
              const label =
                group.customerName ||
                group.phoneNumber ||
                (isRtl ? "مرسل غير معروف" : "Unknown sender");
              return (
                <div key={group.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 px-1">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-semibold text-sm text-foreground truncate">{label}</span>
                      {group.customerName && group.phoneNumber && (
                        <span className="text-xs text-muted-foreground" dir="ltr">{group.phoneNumber}</span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {isRtl ? `${group.jobs.length} ملف` : `${group.jobs.length} file${group.jobs.length === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleAcceptMany(group.key, group.jobs)}
                      className="shrink-0 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20"
                    >
                      {bulkAcceptingKey === group.key
                        ? (isRtl ? "جارٍ القبول..." : "Accepting...")
                        : (isRtl ? `قبول الكل (${group.jobs.length})` : `Accept all (${group.jobs.length})`)}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRejectAllTarget({ key: group.key, label, jobs: group.jobs })}
                      className="shrink-0 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      {bulkRejectingKey === group.key
                        ? (isRtl ? "جارٍ الرفض..." : "Rejecting...")
                        : (isRtl ? `رفض الكل (${group.jobs.length})` : `Reject all (${group.jobs.length})`)}
                    </Button>
                    </div>
                  </div>
                  <div className="grid gap-3">
                    {group.jobs.map((job) => {
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
                                <p className="font-semibold text-foreground truncate">{job.fileName}</p>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground mt-1">
                                  <span>{new Date(job.uploadDate).toLocaleString(isRtl ? "ar-EG" : "en-US", { numberingSystem: "latn" })}</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                    {job.printPreferences?.colorMode === "blackWhite" ? (isRtl ? "أبيض وأسود" : "B&W") : (isRtl ? "ملون" : "Color")}
                                  </span>
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                    {job.printPreferences?.copies || 1}x
                                  </span>
                                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                                    {job.printPreferences?.paperType || "normal"}
                                  </span>
                                  {job.notes && (
                                    <span className="text-[11px] text-muted-foreground italic truncate max-w-[200px]">"{job.notes}"</span>
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
                                disabled={busy}
                                onClick={() => handleAcceptReview(job)}
                                className="text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20"
                              >
                                {isRtl ? "قبول" : "Accept"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => { setRejectDialogJob(job); setRejectReason("bad_file"); setRejectNote(""); }}
                                className="text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                              >
                                {isRtl ? "رفض" : "Reject"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => setBlockJob(job)}
                                title={isRtl ? "حظر المرسل" : "Block uploader"}
                                className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                              >
                                {isRtl ? "حظر" : "Block"}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <BlockUploaderDialog
        job={blockJob}
        isRtl={isRtl}
        onClose={() => setBlockJob(null)}
      />

      <BlockedUploadersDialog
        open={blocklistOpen}
        isRtl={isRtl}
        onClose={() => setBlocklistOpen(false)}
      />

      {/* Reject-all confirmation — no reason input, just a yes/no gate. */}
      <Dialog open={rejectAllTarget !== null} onOpenChange={(open) => { if (!open) setRejectAllTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isRtl
                ? `رفض ${rejectAllTarget?.jobs.length ?? 0} طلب؟`
                : `Reject ${rejectAllTarget?.jobs.length ?? 0} job${rejectAllTarget?.jobs.length === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {isRtl
                ? `سيتم رفض كل ملفات ${rejectAllTarget?.label ?? ""} وحذفها. لا يمكن التراجع عن هذا الإجراء.`
                : `All files from ${rejectAllTarget?.label ?? ""} will be rejected and deleted. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectAllTarget(null)}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button
              onClick={handleRejectMany}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRtl ? "رفض الكل" : "Reject all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <label className="block text-sm font-semibold text-foreground mb-2">
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
              <label className="block text-sm font-semibold text-foreground mb-2">
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
