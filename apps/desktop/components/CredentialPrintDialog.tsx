import React, { useEffect, useState } from "react";
import { getPrinters, PrinterInfo } from "../lib/electronPrint";
import { readEnumPref, writePref } from "@atba3li/shared/lib/prefs";
import type { CardPaperSize } from "../types";
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

export interface CredentialPrintOptions {
  printerName: string;
  copies: number;
  color: boolean;
  paperSize: CardPaperSize;
  includeWebsite: boolean;
  includeShopSocial: boolean;
  includeShopContact: boolean;
  /** Whether the shop-wide default notice prints when the card has no override of its own. */
  includeNotice: boolean;
}

interface CredentialPrintDialogProps {
  open: boolean;
  isRtl: boolean;
  defaultPrinterName: string;
  hasWebsite: boolean;
  hasShopSocial: boolean;
  hasShopContact: boolean;
  /** True when there's a shop-wide default notice AND this card has no override — i.e. the toggle matters. */
  hasDefaultNotice: boolean;
  submitting: boolean;
  onClose: () => void;
  onPrint: (opts: CredentialPrintOptions) => void | Promise<unknown>;
}

const PAPER_SIZE_LABELS: Record<CardPaperSize, { en: string; ar: string }> = {
  thermal58: { en: "Thermal receipt (58mm)", ar: "إيصال حراري (58مم)" },
  thermal80: { en: "Thermal receipt (80mm)", ar: "إيصال حراري (80مم)" },
  a5: { en: "A5", ar: "A5" },
  a4: { en: "A4", ar: "A4" },
};

const PAPER_SIZES: CardPaperSize[] = ["thermal58", "thermal80", "a5", "a4"];

const rememberedPaperSize = (): CardPaperSize => readEnumPref("credentialCardPaperSize", PAPER_SIZES, "a4");

const CredentialPrintDialog: React.FC<CredentialPrintDialogProps> = ({
  open,
  isRtl,
  defaultPrinterName,
  hasWebsite,
  hasShopSocial,
  hasShopContact,
  hasDefaultNotice,
  submitting,
  onClose,
  onPrint,
}) => {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [opts, setOpts] = useState<CredentialPrintOptions>({
    printerName: defaultPrinterName,
    copies: 1,
    color: false,
    paperSize: rememberedPaperSize(),
    includeWebsite: true,
    includeShopSocial: true,
    includeShopContact: true,
    includeNotice: true,
  });

  useEffect(() => {
    if (!open) return;
    setOpts({
      printerName: defaultPrinterName,
      copies: 1,
      color: false,
      paperSize: rememberedPaperSize(),
      includeWebsite: true,
      includeShopSocial: true,
      includeShopContact: true,
      includeNotice: true,
    });
    getPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [open, defaultPrinterName]);

  const set = <K extends keyof CredentialPrintOptions>(key: K, value: CredentialPrintOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  // Remembered per-machine, not per-shop-settings — this is a "what's loaded
  // in the printer right now" choice, which stays put across cards/sessions.
  const setPaperSize = (size: CardPaperSize) => {
    set("paperSize", size);
    writePref("credentialCardPaperSize", size);
  };

  const printerGone =
    !!opts.printerName && printers.length > 0 && !printers.some((p) => p.name === opts.printerName);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRtl ? "خيارات طباعة البطاقة" : "Card print options"}</DialogTitle>
          <DialogDescription>
            {isRtl ? "اختر حجم الورق والحقول التي تظهر على البطاقة" : "Pick the paper size and which fields show on the card"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <Label className="text-xs">{isRtl ? "حجم الورق" : "Paper size"}</Label>
            <Select value={opts.paperSize} onValueChange={(v) => setPaperSize(v as CardPaperSize)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAPER_SIZES.map((size) => (
                  <SelectItem key={size} value={size}>
                    {isRtl ? PAPER_SIZE_LABELS[size].ar : PAPER_SIZE_LABELS[size].en}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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

          <div className="space-y-2 pt-1 border-t border-border">
            <Label className="text-xs text-muted-foreground">{isRtl ? "الحقول الظاهرة على البطاقة" : "Fields shown on the card"}</Label>
            {hasWebsite && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "الموقع الإلكتروني" : "Website"}</Label>
                <Switch checked={opts.includeWebsite} onCheckedChange={(c) => set("includeWebsite", c)} />
              </div>
            )}
            {hasShopSocial && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "حسابات المتجر الاجتماعية" : "Shop's social accounts"}</Label>
                <Switch checked={opts.includeShopSocial} onCheckedChange={(c) => set("includeShopSocial", c)} />
              </div>
            )}
            {hasShopContact && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "بيانات تواصل المتجر" : "Shop contact info"}</Label>
                <Switch checked={opts.includeShopContact} onCheckedChange={(c) => set("includeShopContact", c)} />
              </div>
            )}
            {hasDefaultNotice && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <Label className="text-xs cursor-pointer">{isRtl ? "الملاحظة الافتراضية" : "Default notice"}</Label>
                <Switch checked={opts.includeNotice} onCheckedChange={(c) => set("includeNotice", c)} />
              </div>
            )}
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

export default CredentialPrintDialog;
