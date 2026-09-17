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

export interface PosterPrintOptions {
  printerName: string;
  copies: number;
  color: boolean;
}

interface PosterPrintOptionsDialogProps {
  open: boolean;
  isRtl: boolean;
  defaultPrinterName: string;
  submitting: boolean;
  onClose: () => void;
  onPrint: (opts: PosterPrintOptions) => void | Promise<unknown>;
}

const PosterPrintOptionsDialog: React.FC<PosterPrintOptionsDialogProps> = ({
  open,
  isRtl,
  defaultPrinterName,
  submitting,
  onClose,
  onPrint,
}) => {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [opts, setOpts] = useState<PosterPrintOptions>({
    printerName: defaultPrinterName,
    copies: 1,
    color: true,
  });

  // Re-seed each time the dialog opens, and fetch the printer list fresh —
  // a printer plugged in after the app started should still show up.
  useEffect(() => {
    if (!open) return;
    setOpts({ printerName: defaultPrinterName, copies: 1, color: true });
    getPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [open, defaultPrinterName]);

  const set = <K extends keyof PosterPrintOptions>(key: K, value: PosterPrintOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  const printerGone =
    !!opts.printerName && printers.length > 0 && !printers.some((p) => p.name === opts.printerName);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRtl ? "خيارات طباعة الملصق" : "Poster print options"}</DialogTitle>
          <DialogDescription>
            {isRtl ? "ملصق A4 واحد بالشعار وبيانات المتجر" : "One A4 poster with your shop's logo and details"}
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
            {printerGone && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                {isRtl ? "الطابعة المحفوظة غير متصلة." : "The saved printer isn't connected."}
              </p>
            )}
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
          <Button onClick={() => onPrint(opts)} disabled={submitting}>
            {submitting ? (isRtl ? "جارِ الطباعة…" : "Printing…") : isRtl ? "طباعة" : "Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PosterPrintOptionsDialog;
