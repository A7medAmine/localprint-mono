import React, { useEffect, useState } from "react";
import { getPrinters, PrinterInfo } from "../lib/electronPrint";
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

export interface CvPrintOptions {
  printerName: string;
  copies: number;
  color: boolean;
}

interface CvPrintDialogProps {
  open: boolean;
  isRtl: boolean;
  defaultPrinterName: string;
  submitting: boolean;
  onClose: () => void;
  onPrint: (opts: CvPrintOptions) => void | Promise<unknown>;
  onExportPdf: (opts: CvPrintOptions) => void | Promise<unknown>;
}

const CvPrintDialog: React.FC<CvPrintDialogProps> = ({
  open,
  isRtl,
  defaultPrinterName,
  submitting,
  onClose,
  onPrint,
  onExportPdf,
}) => {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [opts, setOpts] = useState<CvPrintOptions>({ printerName: defaultPrinterName, copies: 1, color: true });

  useEffect(() => {
    if (!open) return;
    setOpts({ printerName: defaultPrinterName, copies: 1, color: true });
    getPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [open, defaultPrinterName]);

  const set = <K extends keyof CvPrintOptions>(key: K, value: CvPrintOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRtl ? "طباعة السيرة الذاتية" : "Print CV"}</DialogTitle>
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

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label className="text-xs cursor-pointer">{isRtl ? "ألوان" : "Colour"}</Label>
            <Switch checked={opts.color} onCheckedChange={(c) => set("color", c)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {isRtl ? "إلغاء" : "Cancel"}
          </Button>
          <Button variant="outline" onClick={() => onExportPdf(opts)} disabled={submitting}>
            {isRtl ? "تصدير PDF" : "Export PDF"}
          </Button>
          <Button onClick={() => onPrint(opts)} disabled={submitting}>
            {submitting ? (isRtl ? "جارِ الطباعة…" : "Printing…") : isRtl ? "طباعة" : "Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CvPrintDialog;
