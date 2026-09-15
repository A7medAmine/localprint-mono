import React, { useEffect, useRef, useState } from "react";
import { PaperType } from "../../../types";
import { storageService } from "../../../services/storageService";
import { formatRelativeTime } from "../../../utils/timeUtils";
import { toast } from "../../../components/ui/use-toast";
import { ToastAction } from "../../../components/ui/toast";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { Icon, fileTypeIcon } from "../../../components/ui/icon";
import { useAdmin } from "../AdminContext";
import { openAdminEventSource } from "../../../utils/adminEvents";

const formatFileSize = (bytes: number) => {
  if (!bytes || bytes === 0) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

interface GmailPanelProps {
  paperTypes: PaperType[];
  /** Called after emails are imported so the parent can refresh its job list. */
  onJobsImported: () => void;
}

const GmailPanel: React.FC<GmailPanelProps> = ({ paperTypes, onJobsImported }) => {
  const { isRtl, lang } = useAdmin();

  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState("");
  const [gmailPolling, setGmailPolling] = useState(false);
  const [gmailDisconnectConfirm, setGmailDisconnectConfirm] = useState(false);
  const [gmailPollResult] = useState<string | null>(null);
  const [gmailPending, setGmailPending] = useState<any[]>([]);
  const [gmailSelectedIds, setGmailSelectedIds] = useState<Set<number>>(new Set());
  const [gmailImporting, setGmailImporting] = useState(false);
  const [gmailLastPolledAt] = useState<string | null>(null);
  const [gmailReviewOpen, setGmailReviewOpen] = useState(false);
  const [gmailFilterText, setGmailFilterText] = useState("");
  const [gmailFilterDate, setGmailFilterDate] = useState<"today" | "week" | "all">("all");
  const [gmailFilterType, setGmailFilterType] = useState<"all" | "pdf" | "images" | "other">("all");
  const [gmailReviewOverrides, setGmailReviewOverrides] = useState<
    Record<string, { copies: number; colorMode: string; paperType: string }>
  >({});
  const [gmailPollInterval, setGmailPollInterval] = useState(60);
  const [gmailReplyTemplate, setGmailReplyTemplate] = useState("");
  const [gmailReplyTemplateLang, setGmailReplyTemplateLang] = useState<"en" | "ar">("en");
  const [gmailReadyTemplate, setGmailReadyTemplate] = useState("");
  const [gmailReadyTemplateLang, setGmailReadyTemplateLang] = useState<"en" | "ar">("en");
  const gmailReplyRef = useRef<HTMLTextAreaElement>(null);
  const gmailReadyRef = useRef<HTMLTextAreaElement>(null);

  const loadGmailStatus = async () => {
    try {
      const [status, settings] = await Promise.all([
        storageService.getGmailStatus(),
        storageService.getGmailSettings(),
      ]);
      setGmailConnected(status.connected);
      setGmailEmail(status.email || "");
      setGmailReplyTemplate(settings.replyTemplate || "");
      setGmailReplyTemplateLang(settings.replyTemplateLang || "en");
      setGmailReadyTemplate(settings.readyTemplate || "");
      setGmailReadyTemplateLang(settings.readyTemplateLang || "en");
      setGmailPollInterval(settings.pollInterval || 60);
    } catch (err) {
      console.error("Failed to load Gmail status:", err);
    }
  };

  const loadGmailPending = async () => {
    try {
      const pending = await storageService.getGmailPending();
      setGmailPending(pending);
    } catch (err) {
      console.error("Failed to load pending emails:", err);
    }
  };

  useEffect(() => {
    loadGmailStatus();
    loadGmailPending();
    // The persistent notification toast lives in AdminView's EventSource; this
    // one just keeps the pending list fresh while the tab is open.
    const es = openAdminEventSource();
    es.addEventListener("gmail-new", () => { loadGmailPending(); });
    es.onerror = () => {};
    return () => { es.close(); };
  }, []);

  const toggleGmailSelection = (id: number) => {
    setGmailSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGmailFilteredSelectAll = () => {
    const filteredIds = gmailFilteredPending.map((p) => p.id);
    const allFilteredSelected = filteredIds.every((id) => gmailSelectedIds.has(id));
    if (allFilteredSelected) {
      setGmailSelectedIds((prev) => {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setGmailSelectedIds((prev) => {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const handleGmailConnect = async () => {
    try {
      const url = await storageService.getGmailAuthUrl();
      const popup = window.open(url, "gmail-auth", "width=600,height=700");
      const started = Date.now();
      const MAX_WAIT_MS = 2 * 60_000;
      const timer = setInterval(async () => {
        if (Date.now() - started > MAX_WAIT_MS) {
          clearInterval(timer);
          return;
        }
        if (popup && popup.closed) {
          clearInterval(timer);
          await loadGmailStatus();
          return;
        }
        if (!popup) {
          try {
            const status = await storageService.getGmailStatus();
            if (status.connected) {
              clearInterval(timer);
              await loadGmailStatus();
            }
          } catch {
            /* transient — keep polling */
          }
        }
      }, 1500);
    } catch (err) {
      console.error("Failed to connect Gmail:", err);
    }
  };

  const handleGmailDisconnect = () => {
    setGmailDisconnectConfirm(true);
  };

  const confirmGmailDisconnect = async () => {
    setGmailDisconnectConfirm(false);
    try {
      await storageService.disconnectGmail();
      setGmailConnected(false);
      setGmailEmail("");
      toast({ title: isRtl ? "تم قطع الاتصال بـ Gmail" : "Gmail disconnected", variant: "success" });
    } catch (err) {
      toast({ title: isRtl ? "فشل قطع الاتصال" : "Failed to disconnect", variant: "destructive" });
    }
  };

  const handleGmailPoll = async () => {
    if (gmailPolling) return;
    setGmailPolling(true);
    try {
      await storageService.triggerGmailPoll();
      await loadGmailPending();
    } catch (err) {
      console.error("Failed to poll Gmail:", err);
    } finally {
      setGmailPolling(false);
    }
  };

  const gmailFilteredPending = gmailPending.filter((e) => {
    if (gmailFilterText) {
      const q = gmailFilterText.toLowerCase();
      const matchesText =
        (e.email_from || "").toLowerCase().includes(q) ||
        (e.email_address || "").toLowerCase().includes(q) ||
        (e.subject || "").toLowerCase().includes(q);
      if (!matchesText) return false;
    }
    if (gmailFilterDate === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const fetched = new Date(e.fetched_at || e.received_at || 0);
      if (fetched < today) return false;
    } else if (gmailFilterDate === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const fetched = new Date(e.fetched_at || e.received_at || 0);
      if (fetched < weekAgo) return false;
    }
    if (gmailFilterType !== "all") {
      const atts = e.attachment_meta || [];
      if (atts.length === 0) return gmailFilterType === "other";
      const hasMatch = atts.some((att: any) => {
        const mt = (att.mimeType || "").toLowerCase();
        if (gmailFilterType === "pdf") return mt.includes("pdf");
        if (gmailFilterType === "images") return mt.includes("image");
        return !mt.includes("pdf") && !mt.includes("image");
      });
      if (!hasMatch) return false;
    }
    return true;
  });
  const gmailSelectedEmails = gmailPending.filter((e) => gmailSelectedIds.has(e.id));

  const handleGmailImportSelected = async () => {
    if (gmailSelectedIds.size === 0) return;
    const defaults: Record<string, { copies: number; colorMode: string; paperType: string }> = {};
    for (const email of gmailSelectedEmails) {
      for (let i = 0; i < (email.attachment_meta || []).length; i++) {
        defaults[`${email.id}_${i}`] = { copies: 1, colorMode: "color", paperType: "normal" };
      }
    }
    setGmailReviewOverrides(defaults);
    setGmailReviewOpen(true);
  };

  const handleGmailConfirmImport = async () => {
    setGmailReviewOpen(false);
    setGmailImporting(true);
    try {
      const result = await storageService.importGmailEmails(
        Array.from(gmailSelectedIds),
        gmailReviewOverrides,
      );
      const imported = result.imported || [];
      const successCount = imported.filter((r: any) => !r.error).length;
      const errorCount = imported.filter((r: any) => r.error).length;
      if (errorCount > 0) {
        const errors = imported
          .filter((r: any) => r.error)
          .map((r: any) => `${r.subject || r.id}: ${r.error}`)
          .join("; ");
        toast({ title: `${successCount} imported, ${errorCount} failed`, description: errors, variant: "destructive" });
      } else {
        toast({ title: `${successCount} email(s) imported`, variant: "success" });
      }
      setGmailSelectedIds(new Set());
      await loadGmailPending();
      onJobsImported();
    } catch (err: any) {
      console.error("Failed to import emails:", err);
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setGmailImporting(false);
    }
  };

  const updateGmailOverride = (key: string, field: string, value: any) => {
    setGmailReviewOverrides((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const handleGmailDiscardSelected = async () => {
    const ids = Array.from(gmailSelectedIds);
    for (const id of ids) {
      try {
        await storageService.discardGmailEmail(id);
      } catch (err) {
        console.error("Failed to discard email:", err);
      }
    }
    setGmailSelectedIds(new Set());
    await loadGmailPending();
    toast({
      title: `${ids.length} email(s) discarded`,
      action: (
        <ToastAction
          altText="Undo discard"
          onClick={async () => {
            for (const id of ids) {
              try {
                await storageService.restoreGmailEmail(id);
              } catch (err) {
                console.error("Failed to restore email:", err);
              }
            }
            await loadGmailPending();
          }}
        >
          Undo
        </ToastAction>
      ),
      duration: 5000,
    });
  };

  const insertInto = (
    ref: React.RefObject<HTMLTextAreaElement | null>,
    value: string,
    setValue: (v: string) => void,
    placeholder: string,
  ) => {
    const textarea = ref.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = value.slice(0, start) + placeholder + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;
    });
  };

  const insertPlaceholder = (placeholder: string) =>
    insertInto(gmailReplyRef, gmailReplyTemplate, setGmailReplyTemplate, placeholder);

  const insertReadyPlaceholder = (placeholder: string) =>
    insertInto(gmailReadyRef, gmailReadyTemplate, setGmailReadyTemplate, placeholder);

  const handleSaveReplyTemplate = async () => {
    try {
      await storageService.saveGmailReplyTemplate(gmailReplyTemplate, gmailReplyTemplateLang);
      toast({ title: isRtl ? "تم حفظ قالب الرد" : "Reply template saved", variant: "success" });
    } catch (err) {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const handleSaveReadyTemplate = async () => {
    try {
      await storageService.saveGmailReadyTemplate(gmailReadyTemplate, gmailReadyTemplateLang);
      toast({ title: isRtl ? "تم حفظ قالب الإشعار" : "Ready template saved", variant: "success" });
    } catch (err) {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  return (
    <>
      <div className="max-w-5xl mx-auto">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22.288 5.292A1.2 1.2 0 0021.6 4.8H2.4a1.2 1.2 0 00-.688.492l10.288 7.712 10.288-7.712zM21.6 7.2l-9.6 7.2L2.4 7.2v9.6a1.2 1.2 0 001.2 1.2h16.8a1.2 1.2 0 001.2-1.2V7.2z" />
                </svg>
              </div>
              <div>
                <CardTitle className="text-base">{isRtl ? "البريد الإلكتروني (Gmail)" : "Email-to-Print (Gmail)"}</CardTitle>
                <CardDescription>{isRtl ? "فحص البريد واستيراد المرفقات كطلبات طباعة" : "Check mail and import attachments as print jobs"}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${gmailConnected ? "bg-green-500 dark:bg-green-400" : "bg-gray-300 dark:bg-gray-500"}`} />
                <span className="text-sm font-medium text-foreground">
                  {gmailConnected
                    ? isRtl ? `متصل: ${gmailEmail}` : `Connected: ${gmailEmail}`
                    : isRtl ? "غير متصل" : "Not connected"}
                </span>
                {gmailConnected && gmailPending.length > 0 && (
                  <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-xs rounded-full font-medium">
                    {gmailPending.length} {isRtl ? "بريد جديد" : "pending"}
                  </span>
                )}
                {gmailConnected && gmailLastPolledAt && (
                  <span className="text-xs text-muted-foreground">
                    {isRtl ? "آخر فحص" : "Last checked"}: {formatRelativeTime(gmailLastPolledAt, lang)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!gmailConnected ? (
                  <Button size="sm" onClick={handleGmailConnect}>
                    <svg className="w-4 h-4 me-1.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.288 5.292A1.2 1.2 0 0021.6 4.8H2.4a1.2 1.2 0 00-.688.492l10.288 7.712 10.288-7.712zM21.6 7.2l-9.6 7.2L2.4 7.2v9.6a1.2 1.2 0 001.2 1.2h16.8a1.2 1.2 0 001.2-1.2V7.2z" />
                    </svg>
                    {isRtl ? "الاتصال بـ Gmail" : "Connect Gmail"}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={handleGmailPoll} disabled={gmailPolling}>
                      <svg className={`w-4 h-4 me-1.5 ${gmailPolling ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {gmailPolling ? (isRtl ? "جارٍ الفحص..." : "Checking...") : isRtl ? "فحص البريد الآن" : "Check Mail Now"}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={handleGmailDisconnect}>
                      <svg className="w-4 h-4 me-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                      {isRtl ? "قطع الاتصال" : "Disconnect"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {gmailPollResult && (
              <div className={`text-sm px-3 py-2 rounded-lg ${gmailPollResult.includes("Error") ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400" : "bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400"}`}>
                {gmailPollResult}
              </div>
            )}

            {/* Poll Interval */}
            <div className="p-4 bg-muted/40 rounded-xl border border-border">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">
                    {isRtl ? "فترة الفحص التلقائي" : "Auto-check Interval"}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isRtl ? "عدد الثواني بين كل فحص للبريد" : "Seconds between each email check"}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={gmailPollInterval}
                    onChange={(e) => setGmailPollInterval(parseInt(e.target.value) || 60)}
                    className="w-20 h-8 text-sm text-center"
                  />
                  <span className="text-xs text-muted-foreground">{isRtl ? "ثانية" : "sec"}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await storageService.saveGmailPollInterval(gmailPollInterval);
                        toast({ title: isRtl ? "تم حفظ الفاصل الزمني" : "Interval saved", variant: "success" });
                      } catch {
                        toast({ title: isRtl ? "فشل الحفظ" : "Failed to save", variant: "destructive" });
                      }
                    }}
                  >
                    {isRtl ? "حفظ" : "Save"}
                  </Button>
                </div>
              </div>
            </div>

            {/* Auto-reply Template */}
            <div className="p-4 bg-muted/40 rounded-xl border border-border">
              <div className="flex items-center justify-between mb-2 gap-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {isRtl ? "قالب الرد التلقائي" : "Auto-reply Template"}
                </h4>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{isRtl ? "لغة القيم" : "Values language"}</span>
                  <div className="inline-flex rounded-md border border-border overflow-hidden">
                    {(["en", "ar"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setGmailReplyTemplateLang(l)}
                        className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          gmailReplyTemplateLang === l
                            ? "bg-indigo-600 text-white"
                            : "bg-card text-muted-foreground hover:bg-gray-50 dark:hover:bg-gray-700"
                        }`}
                      >
                        {l === "en" ? "EN" : "ع"}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground hidden sm:inline">{isRtl ? "انقر للإدراج" : "Click to insert"}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  "{shopName}",
                  "{fileName}",
                  "{fileCount}",
                  "{jobBreakdown}",
                  "{totalPrice}",
                  "{originalTotal}",
                  "{discountAmount}",
                  "{savingsPercentage}",
                  "{discountRule}",
                  "{totalPages}",
                  "{totalCopies}",
                  "{totalSheets}",
                  "{pageCount}",
                  "{copies}",
                  "{currency}",
                ].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertPlaceholder(v)}
                    className="px-2 py-0.5 text-xs font-mono bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-md hover:bg-indigo-200 dark:hover:bg-indigo-800/60 transition-colors active:scale-95"
                  >
                    {v}
                  </button>
                ))}
              </div>
              <textarea ref={gmailReplyRef} value={gmailReplyTemplate} onChange={(e) => setGmailReplyTemplate(e.target.value)} rows={4} dir={gmailReplyTemplateLang === "ar" ? "rtl" : "ltr"} className="w-full text-sm border border-border rounded-lg p-2 resize-none bg-card text-foreground" placeholder={isRtl ? "اكتب قالب الرد هنا..." : "Write your reply template here..."} />
              <div className="flex justify-end mt-2">
                <Button size="sm" variant="outline" onClick={handleSaveReplyTemplate}>
                  {isRtl ? "حفظ القالب" : "Save Template"}
                </Button>
              </div>
            </div>

            {/* Ready Notification Template — sent when a gmail-sourced job flips to READY */}
            <div className="p-4 bg-muted/40 rounded-xl border border-border">
              <div className="flex items-center justify-between mb-1 gap-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {isRtl ? "قالب إشعار الجاهزية" : "Ready Notification Template"}
                </h4>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{isRtl ? "لغة القيم" : "Values language"}</span>
                  <div className="inline-flex rounded-md border border-border overflow-hidden">
                    {(["en", "ar"] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setGmailReadyTemplateLang(l)}
                        className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          gmailReadyTemplateLang === l
                            ? "bg-emerald-600 text-white"
                            : "bg-card text-muted-foreground hover:bg-gray-50 dark:hover:bg-gray-700"
                        }`}
                      >
                        {l === "en" ? "EN" : "ع"}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground hidden sm:inline">{isRtl ? "انقر للإدراج" : "Click to insert"}</span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">
                {isRtl
                  ? "يُرسَل تلقائيًا عند تحديد الطلب كـ«جاهز». يُرسَل مرة واحدة لكل طلب."
                  : "Sent automatically when a job's status becomes READY. Fires once per job."}
              </p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  "{shopName}",
                  "{customerName}",
                  "{fileName}",
                  "{pageCount}",
                  "{copies}",
                  "{totalSheets}",
                  "{paperType}",
                  "{colorMode}",
                  "{status}",
                  "{totalPrice}",
                  "{currency}",
                ].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertReadyPlaceholder(v)}
                    className="px-2 py-0.5 text-xs font-mono bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 rounded-md hover:bg-emerald-200 dark:hover:bg-emerald-800/60 transition-colors active:scale-95"
                  >
                    {v}
                  </button>
                ))}
              </div>
              <textarea ref={gmailReadyRef} value={gmailReadyTemplate} onChange={(e) => setGmailReadyTemplate(e.target.value)} rows={4} dir={gmailReadyTemplateLang === "ar" ? "rtl" : "ltr"} className="w-full text-sm border border-border rounded-lg p-2 resize-none bg-card text-foreground" placeholder={isRtl ? "اترك فارغًا لاستخدام القالب الافتراضي" : "Leave empty to use the built-in default"} />
              <div className="flex justify-end mt-2">
                <Button size="sm" variant="outline" onClick={handleSaveReadyTemplate}>
                  {isRtl ? "حفظ القالب" : "Save Template"}
                </Button>
              </div>
            </div>

            {gmailConnected && gmailPending.length > 0 && (
              <>
                <hr className="border-border" />
                <div className="border border-border rounded-xl max-h-[600px] overflow-y-auto">
                  {/* Filter bar */}
                  <div className="sticky top-0 z-10 bg-card border-b border-border p-3 space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <h4 className="font-semibold text-foreground flex items-center gap-2">
                        {isRtl ? "رسائل بريد إلكتروني جديدة" : "New Emails"}
                        <button type="button" onClick={handleGmailPoll} disabled={gmailPolling} className="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50" title={isRtl ? "تحديث" : "Refresh"}>
                          <svg className={`w-4 h-4 ${gmailPolling ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        </button>
                      </h4>
                      <span className="text-xs text-muted-foreground">{gmailFilteredPending.length} {isRtl ? "نتيجة" : "result(s)"}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Input value={gmailFilterText} onChange={(e) => setGmailFilterText(e.target.value)} placeholder={isRtl ? "بحث بالمرسل أو الموضوع..." : "Search sender or subject..."} className="h-8 text-sm min-w-[180px] flex-1" />
                      <div className="flex items-center gap-1">
                        {(["all", "today", "week"] as const).map((d) => (
                          <button key={d} type="button" onClick={() => setGmailFilterDate(d)} className={`px-2 py-1 text-xs rounded-lg ${gmailFilterDate === d ? "bg-gray-900 dark:bg-gray-950 text-white" : "bg-muted text-muted-foreground hover:bg-muted"}`}>
                            {d === "all" ? (isRtl ? "الكل" : "All") : d === "today" ? (isRtl ? "اليوم" : "Today") : isRtl ? "7 أيام" : "7 days"}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        {(["all", "pdf", "images", "other"] as const).map((tp) => (
                          <button key={tp} type="button" onClick={() => setGmailFilterType(tp)} className={`px-2 py-1 text-xs rounded-lg ${gmailFilterType === tp ? "bg-gray-900 dark:bg-gray-950 text-white" : "bg-muted text-muted-foreground hover:bg-muted"}`}>
                            {tp === "all" ? (isRtl ? "الكل" : "All") : tp === "pdf" ? "PDF" : tp === "images" ? (isRtl ? "صور" : "Images") : isRtl ? "أخرى" : "Other"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={gmailSelectedIds.size === 0 || gmailImporting} onClick={handleGmailImportSelected}>
                        {gmailImporting ? (isRtl ? "جارٍ الاستيراد..." : "Importing...") : isRtl ? `استيراد المحدد (${gmailSelectedIds.size})` : `Import Selected (${gmailSelectedIds.size})`}
                      </Button>
                      <Button size="sm" variant="outline" disabled={gmailSelectedIds.size === 0} onClick={handleGmailDiscardSelected}>
                        {isRtl ? "تجاهل" : "Discard"}
                      </Button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/40 border-b border-border">
                          <th className="p-3 text-start">
                            <input type="checkbox" checked={gmailFilteredPending.length > 0 && gmailFilteredPending.every((e) => gmailSelectedIds.has(e.id))} onChange={toggleGmailFilteredSelectAll} className="rounded border-border" />
                          </th>
                          <th className="p-3 text-start font-semibold text-muted-foreground dark:text-gray-500">{isRtl ? "من" : "From"}</th>
                          <th className="p-3 text-start font-semibold text-muted-foreground dark:text-gray-500">{isRtl ? "الموضوع" : "Subject"}</th>
                          <th className="p-3 text-start font-semibold text-muted-foreground dark:text-gray-500">{isRtl ? "المرفقات" : "Attachments"}</th>
                          <th className="p-3 text-start font-semibold text-muted-foreground dark:text-gray-500">{isRtl ? "التاريخ" : "Date"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gmailFilteredPending.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                              {isRtl ? "لا توجد رسائل مطابقة" : "No matching emails found"}
                            </td>
                          </tr>
                        ) : (
                          gmailFilteredPending.map((email) => (
                            <tr key={email.id} onClick={() => toggleGmailSelection(email.id)} className={`cursor-pointer border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 ${gmailSelectedIds.has(email.id) ? "bg-blue-50 dark:bg-blue-900/20" : ""}`}>
                              <td className="p-3">
                                <input type="checkbox" checked={gmailSelectedIds.has(email.id)} onChange={(e) => { e.stopPropagation(); toggleGmailSelection(email.id); }} className="rounded border-border" />
                              </td>
                              <td className="p-3">
                                <div className="font-medium text-foreground">{email.email_from}</div>
                                <div className="text-xs text-muted-foreground">{email.email_address}</div>
                              </td>
                              <td className="p-3 text-foreground max-w-xs truncate">{email.subject}</td>
                              <td className="p-3">
                                {email.attachment_meta && email.attachment_meta.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {email.attachment_meta.map((att: any, i: number) => (
                                      <span key={i} className="px-2 py-0.5 bg-muted text-muted-foreground dark:text-gray-500 rounded text-xs flex items-center gap-1" title={`${att.filename} (${formatFileSize(att.size)})`}>
                                        <Icon name={fileTypeIcon(att.mimeType)} className="h-3.5 w-3.5" />
                                        <span className="max-w-[80px] truncate">{att.filename}</span>
                                        {att.size > 0 && <span className="text-muted-foreground">({formatFileSize(att.size)})</span>}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground text-xs">{isRtl ? "لا يوجد" : "None"}</span>
                                )}
                              </td>
                              <td className="p-3 text-muted-foreground text-xs">{email.fetched_at ? new Date(email.fetched_at).toLocaleString() : ""}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Review modal before import */}
        <Dialog open={gmailReviewOpen} onOpenChange={setGmailReviewOpen}>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{isRtl ? "مراجعة الطلبات قبل الاستيراد" : "Review Before Import"}</DialogTitle>
              <DialogDescription>{isRtl ? "تعديل الإعدادات لكل مرفق قبل إنشاء طلبات الطباعة" : "Adjust settings for each attachment before creating print jobs"}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {gmailSelectedEmails.map((email) => (
                <div key={email.id} className="border border-border rounded-xl p-4">
                  <div className="font-semibold text-foreground mb-1">{email.subject || "(no subject)"}</div>
                  <div className="text-xs text-muted-foreground mb-3">{email.email_from} &lt;{email.email_address}&gt;</div>
                  {(email.attachment_meta || []).length === 0 ? (
                    <div className="text-sm text-muted-foreground italic">{isRtl ? "لا توجد مرفقات" : "No attachments"}</div>
                  ) : (
                    <div className="space-y-2">
                      {email.attachment_meta.map((att: any, i: number) => {
                        const key = `${email.id}_${i}`;
                        const ov = gmailReviewOverrides[key] || { copies: 1, colorMode: "color", paperType: "normal" };
                        return (
                          <div key={i} className="flex flex-wrap items-center gap-3 p-2 bg-muted/40 rounded-lg">
                            <span className="text-sm font-medium text-foreground min-w-[120px] truncate">{att.filename}</span>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-muted-foreground">{isRtl ? "نسخ" : "Copies"}</label>
                              <Input type="number" min={1} max={99} value={ov.copies} onChange={(e) => updateGmailOverride(key, "copies", parseInt(e.target.value) || 1)} className="w-16 h-8 text-sm" />
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-muted-foreground">{isRtl ? "الألوان" : "Color"}</label>
                              <select value={ov.colorMode} onChange={(e) => updateGmailOverride(key, "colorMode", e.target.value)} className="text-sm border border-border rounded-lg px-2 py-1 h-8 bg-card text-foreground">
                                <option value="color">{isRtl ? "ملون" : "Color"}</option>
                                <option value="blackWhite">{isRtl ? "أبيض وأسود" : "B&W"}</option>
                              </select>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-muted-foreground">{isRtl ? "الورق" : "Paper"}</label>
                              <select value={ov.paperType} onChange={(e) => updateGmailOverride(key, "paperType", e.target.value)} className="text-sm border border-border rounded-lg px-2 py-1 h-8 bg-card text-foreground">
                                {paperTypes.map((pt) => (
                                  <option key={pt.id} value={pt.id}>{isRtl ? pt.nameAr || pt.name : pt.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setGmailReviewOpen(false)}>{isRtl ? "إلغاء" : "Cancel"}</Button>
              <Button onClick={handleGmailConfirmImport}>{isRtl ? "تأكيد الاستيراد" : "Confirm Import"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Gmail Disconnect Confirmation */}
      <AlertDialog open={gmailDisconnectConfirm} onOpenChange={setGmailDisconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "قطع الاتصال بـ Gmail" : "Disconnect Gmail"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? "هل أنت متأكد من قطع الاتصال بـ Gmail؟ لن يتم استيراد أي رسائل بريد إلكتروني جديدة حتى تعيد الاتصال."
                : "Are you sure you want to disconnect Gmail? No new emails will be imported until you reconnect."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmGmailDisconnect} className="bg-destructive text-destructive-foreground dark:text-destructive-foreground hover:bg-destructive/90 dark:hover:bg-destructive/70">
              {isRtl ? "قطع الاتصال" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default GmailPanel;
