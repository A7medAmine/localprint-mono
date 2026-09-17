import React, { useEffect, useState } from "react";
import { PrintJob, ShopSettings } from "../../../types";
import { PrinterInfo } from "../../../lib/electronPrint";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useAdmin } from "../AdminContext";
import { parsePageRanges, type StudioPrintOptions } from "./useAdminJobs";
import { storageService } from "../../../services/storageService";
import FilePreview from "@atba3li/shared/components/preview/FilePreview";

interface PrintOptionsDialogProps {
  job: PrintJob | null;
  printers: PrinterInfo[];
  settings: ShopSettings;
  onClose: () => void;
  onPrint: (job: PrintJob, opts: StudioPrintOptions) => void | Promise<unknown>;
}

const PAGE_SIZES = ["default", "A4", "A3", "A5", "Letter", "Legal", "Tabloid"];

const PrintOptionsDialog: React.FC<PrintOptionsDialogProps> = ({ job, printers, settings, onClose, onPrint }) => {
  const { isRtl } = useAdmin();
  const savedDefault = settings.defaultPrinterName || "";

  const [opts, setOpts] = useState<StudioPrintOptions>({
    printerName: savedDefault,
    copies: 1,
    color: true,
    duplexMode: "simplex",
    collate: true,
    landscape: false,
    pageSize: "default",
    pageRanges: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Resolve the file URL as soon as the dialog opens for a job so the
  // preview pane can start loading immediately.
  useEffect(() => {
    setPreviewUrl(null);
    if (!job) return;
    let cancelled = false;
    storageService.getFileUrl(job.id).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [job?.id]);

  // Re-seed each time the dialog opens for a job: job prefs win for copies /
  // colour, the saved per-printer defaults fill in the hardware settings.
  useEffect(() => {
    if (!job) return;
    const d = (settings.printerDefaults || {})[savedDefault];
    setOpts({
      printerName: savedDefault,
      copies: Math.max(1, Number(job.printPreferences?.copies) || 1),
      color: job.printPreferences?.colorMode
        ? job.printPreferences.colorMode !== "blackWhite"
        : d?.color ?? true,
      duplexMode: (d?.duplexMode as StudioPrintOptions["duplexMode"]) || "simplex",
      collate: d?.collate ?? true,
      landscape: d?.landscape ?? false,
      pageSize: "default",
      pageRanges: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const set = <K extends keyof StudioPrintOptions>(key: K, value: StudioPrintOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  const printerGone = !!opts.printerName && printers.length > 0 && !printers.some((p) => p.name === opts.printerName);

  const submit = async () => {
    if (!job) return;
    setSubmitting(true);
    try {
      await onPrint(job, opts);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={job !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-6xl w-[95vw] h-[90vh] flex flex-col p-0 gap-0 rounded-2xl overflow-hidden">
        <DialogHeader className="px-5 py-3 border-b border-border shrink-0">
          <DialogTitle>{isRtl ? "خيارات الطباعة" : "Print options"}</DialogTitle>
          <DialogDescription>{job?.fileName}</DialogDescription>
        </DialogHeader>

        {/* Big preview left, settings sidebar right — same split as the OS
            print dialog (Ctrl+P), so the layout is already familiar. */}
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
          <div className="flex-1 min-w-0 min-h-0 bg-gray-100 dark:bg-gray-950 border-b sm:border-b-0 sm:border-e border-border h-[45vh] sm:h-auto">
            <FilePreview
              url={previewUrl}
              fileName={job?.fileName || ""}
              fileType={job?.fileType}
              grayscale={!opts.color}
              pageRanges={parsePageRanges(opts.pageRanges)}
              isRtl={isRtl}
            />
          </div>

          <div className="w-full sm:w-[320px] shrink-0 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 gap-4">
              <div>
                <Label className="text-xs">{isRtl ? "الطابعة" : "Printer"}</Label>
                <Select value={opts.printerName || "__default__"} onValueChange={(v) => set("printerName", v === "__default__" ? "" : v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">{isRtl ? "حوار النظام (اختيار الطابعة)" : "System dialog (pick printer)"}</SelectItem>
                    {printers.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.displayName || p.name}
                        {p.name === savedDefault ? (isRtl ? " — افتراضي" : " — default") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {printerGone && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    {isRtl ? "الطابعة المحفوظة غير متصلة." : "The saved printer isn't connected."}
                  </p>
                )}
                {!opts.printerName && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {isRtl ? "سيظهر حوار الطباعة في النظام." : "The OS print dialog will be shown."}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">{isRtl ? "نسخ" : "Copies"}</Label>
                  <Input type="number" min={1} max={999} className="mt-1" value={opts.copies}
                    onChange={(e) => set("copies", Math.max(1, parseInt(e.target.value || "1", 10) || 1))} />
                </div>
                <div>
                  <Label className="text-xs">{isRtl ? "حجم الورق" : "Paper size"}</Label>
                  <Select value={opts.pageSize} onValueChange={(v) => set("pageSize", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZES.map((s) => (
                        <SelectItem key={s} value={s}>{s === "default" ? (isRtl ? "افتراضي" : "Default") : s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs">{isRtl ? "الوجهين" : "Duplex"}</Label>
                <Select value={opts.duplexMode} onValueChange={(v) => set("duplexMode", v as StudioPrintOptions["duplexMode"])}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="simplex">{isRtl ? "وجه واحد" : "Single-sided"}</SelectItem>
                    <SelectItem value="longEdge">{isRtl ? "وجهين (حافة طويلة)" : "Two-sided (long edge)"}</SelectItem>
                    <SelectItem value="shortEdge">{isRtl ? "وجهين (حافة قصيرة)" : "Two-sided (short edge)"}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{isRtl ? "نطاق الصفحات" : "Page range"}</Label>
                <Input className="mt-1" placeholder={isRtl ? "الكل — مثال: 1-3, 5" : "All — e.g. 1-3, 5"} value={opts.pageRanges}
                  onChange={(e) => set("pageRanges", e.target.value)} />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "ألوان" : "Colour"}</Label>
                <Switch checked={opts.color} onCheckedChange={(c) => set("color", c)} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "ترتيب" : "Collate"}</Label>
                <Switch checked={opts.collate} onCheckedChange={(c) => set("collate", c)} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "أفقي" : "Landscape"}</Label>
                <Switch checked={opts.landscape} onCheckedChange={(c) => set("landscape", c)} />
              </div>
            </div>

            <DialogFooter className="px-5 py-3 border-t border-border shrink-0">
              <Button variant="outline" onClick={onClose} disabled={submitting}>{isRtl ? "إلغاء" : "Cancel"}</Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting ? (isRtl ? "جارٍ الإرسال…" : "Sending…") : isRtl ? "طباعة" : "Print"}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PrintOptionsDialog;
