import React, { useEffect, useMemo, useState } from "react";
import { getPrinters, PrinterInfo } from "../lib/electronPrint";
import type { PaperType, ShopSettings, DiscountRule, PrintJob } from "../types";
import { PrintStatus } from "../types";
import { calculatePrintPrice, calculateJobDiscount, formatPrice, DEFAULT_PAPER_TYPES } from "../utils/pricingUtils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Icon, Spinner } from "./ui/icon";
import { storageService } from "../services/storageService";

export interface ResearchPrintOptions {
  printerName: string;
  copies: number;
  color: boolean;
  paperTypeId: string;
}

interface ResearchPrintDialogProps {
  open: boolean;
  isRtl: boolean;
  defaultPrinterName: string;
  settings: ShopSettings | null;
  /** Phase-5's estimated page count for the currently loaded paper (single copy, one-sided). */
  pageCount: number | null;
  hasImages: boolean;
  /** True while a print/export/copy job is in flight — disables the action buttons. */
  submitting: boolean;
  onClose: () => void;
  onPrint: (opts: ResearchPrintOptions) => void | Promise<unknown>;
  onExportPdf: (opts: ResearchPrintOptions) => void | Promise<unknown>;
  onCopyToWord: () => void | Promise<unknown>;
}

const ResearchPrintDialog: React.FC<ResearchPrintDialogProps> = ({
  open,
  isRtl,
  defaultPrinterName,
  settings,
  pageCount,
  hasImages,
  submitting,
  onClose,
  onPrint,
  onExportPdf,
  onCopyToWord,
}) => {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [opts, setOpts] = useState<ResearchPrintOptions>({
    printerName: defaultPrinterName,
    copies: 1,
    color: true,
    paperTypeId: "normal",
  });

  useEffect(() => {
    if (!open) return;
    setOpts({ printerName: defaultPrinterName, copies: 1, color: true, paperTypeId: "normal" });
    getPrinters().then(setPrinters).catch(() => setPrinters([]));
    storageService.getActiveDiscountRules().then(setDiscountRules).catch(() => setDiscountRules([]));
  }, [open, defaultPrinterName]);

  const set = <K extends keyof ResearchPrintOptions>(key: K, value: ResearchPrintOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  const paperTypes: PaperType[] = useMemo(() => {
    if (settings?.paperTypes && settings.paperTypes.length > 0) return settings.paperTypes;
    return DEFAULT_PAPER_TYPES(settings?.pricing);
  }, [settings]);

  // Pricing breakdown — recomputed live off the dialog's own controls (colour,
  // copies, paper type) and the phase-5 page estimate. A research paper has no
  // real `jobs` row (see ResearchTool.tsx), so this PrintJob is a throwaway
  // shape built only to satisfy calculatePrintPrice's signature — same trick
  // JobCells.tsx uses for the admin quote preview.
  const priceCalc = useMemo(() => {
    if (!settings || !pageCount) return null;
    const job: PrintJob = {
      id: "research-preview",
      customerName: "",
      phoneNumber: "",
      notes: "",
      fileName: "research.pdf",
      fileType: "application/pdf",
      fileSize: 0,
      uploadDate: new Date().toISOString(),
      status: PrintStatus.PENDING,
      printPreferences: {
        colorMode: opts.color ? "color" : "blackWhite",
        copies: opts.copies,
        paperType: opts.paperTypeId,
      },
    };
    const price = calculatePrintPrice(job, settings, pageCount);
    const discount = calculateJobDiscount(job, price.totalPrice, price.totalPages, discountRules);
    return { price, discount };
  }, [settings, pageCount, opts.color, opts.copies, opts.paperTypeId, discountRules]);

  const currency = settings?.currency || "DZD";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRtl ? "طباعة البحث" : "Print research paper"}</DialogTitle>
          <DialogDescription>
            {isRtl ? "ورق A4 — اختر الطابعة أو صدّر كملف PDF" : "A4 paper — pick a printer or export as a PDF file"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <Label className="text-xs">{isRtl ? "الطابعة" : "Printer"}</Label>
            <Select
              value={opts.printerName || "__default__"}
              onValueChange={(v) => set("printerName", v === "__default__" ? "" : v)}
            >
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {isRtl ? "طابعة النظام الافتراضية" : "System default printer"}
                </SelectItem>
                {printers.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.displayName || p.name}
                    {p.name === defaultPrinterName ? (isRtl ? " — افتراضي" : " — default") : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isRtl ? "نسخ" : "Copies"}</Label>
              <Input
                type="number"
                min={1}
                max={99}
                className="mt-1"
                value={opts.copies}
                onChange={(e) => set("copies", Math.max(1, parseInt(e.target.value || "1", 10) || 1))}
              />
            </div>
            <div>
              <Label className="text-xs">{isRtl ? "نوع الورق" : "Paper type"}</Label>
              <Select value={opts.paperTypeId} onValueChange={(v) => set("paperTypeId", v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {paperTypes.map((pt) => (
                    <SelectItem key={pt.id} value={pt.id}>{isRtl ? pt.nameAr : pt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label className="text-xs cursor-pointer">{isRtl ? "ألوان" : "Colour"}</Label>
            <Switch checked={opts.color} onCheckedChange={(c) => set("color", c)} />
          </div>

          {/* Pricing breakdown */}
          <div className="rounded-lg border border-border px-3 py-2.5 space-y-1.5 text-xs">
            {!priceCalc ? (
              <p className="text-muted-foreground">{isRtl ? "جارٍ حساب السعر..." : "Calculating price..."}</p>
            ) : (
              <>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{isRtl ? `${pageCount} صفحة × ${opts.copies} نسخة` : `${pageCount} pages × ${opts.copies} ${opts.copies === 1 ? "copy" : "copies"}`}</span>
                  <span>{formatPrice(priceCalc.price.pricePerPage, currency)} / {isRtl ? "صفحة" : "page"}</span>
                </div>
                {priceCalc.discount.rule && (
                  <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                    <span>{isRtl ? `خصم: ${priceCalc.discount.rule.name}` : `Discount: ${priceCalc.discount.rule.name}`}</span>
                    <span>-{formatPrice(priceCalc.discount.discountAmount, currency)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm font-bold text-foreground pt-1 border-t border-border">
                  <span>{isRtl ? "الإجمالي" : "Total"}</span>
                  <span>{formatPrice(priceCalc.discount.finalAmount, currency)}</span>
                </div>
              </>
            )}
          </div>

          {submitting && (
            <div className="space-y-1.5">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full w-1/3 bg-primary rounded-full animate-[research-print-progress_1.4s_ease-in-out_infinite]" />
              </div>
              <style>{`@keyframes research-print-progress{0%{margin-inline-start:-33%}50%{margin-inline-start:66%}100%{margin-inline-start:-33%}}`}</style>
              <p className="text-xs text-center text-muted-foreground">
                {isRtl ? `جارٍ إعداد ${pageCount ?? ""} صفحة للطباعة...` : `Rendering ${pageCount ?? ""} pages...`}
              </p>
            </div>
          )}

          <div className="pt-1 border-t border-border space-y-1.5">
            <Button type="button" variant="outline" className="w-full gap-2" onClick={onCopyToWord} disabled={submitting}>
              <Icon name="copy" className="w-3.5 h-3.5" />
              {isRtl ? "نسخ النص إلى Word" : "Copy text to Word"}
            </Button>
            {hasImages && (
              <p className="text-[11px] text-muted-foreground text-center">
                {isRtl
                  ? "قد لا تُلصق الصور مع النص — Word لا يفتح روابط الصور المضمّنة دائمًا عند اللصق."
                  : "Images may not come along on paste — Word doesn't reliably resolve embedded images pasted this way."}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {isRtl ? "إلغاء" : "Cancel"}
          </Button>
          <Button variant="outline" onClick={() => onExportPdf(opts)} disabled={submitting}>
            {isRtl ? "تصدير PDF" : "Export PDF"}
          </Button>
          <Button onClick={() => onPrint(opts)} disabled={submitting} className="gap-1.5">
            {submitting && <Spinner className="w-3.5 h-3.5" />}
            {submitting ? (isRtl ? "جارِ الطباعة…" : "Printing…") : isRtl ? "طباعة" : "Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ResearchPrintDialog;
