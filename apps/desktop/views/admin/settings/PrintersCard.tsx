import React, { useEffect, useState } from "react";
import { PrinterJobDefaults, ShopSettings } from "../../../types";
import { isElectron, getPrinters, getPrintEngine, PrinterInfo, PrintEngineInfo } from "../../../lib/electronPrint";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Icon } from "../../../components/ui/icon";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { cn } from "@localprint/shared";
import { useAdmin } from "../AdminContext";

export interface PrintersCardProps {
  /** Shop settings as last saved — the baseline the dirty check compares to. */
  currentSettings: ShopSettings;
  /** Persist this section; the panel owns the shared "saving…" state. */
  onPersist: (section: string, subset: { defaultPrinterName: string; printerDefaults: Record<string, PrinterJobDefaults> }) => void;
  /** The panel's shared save bar, so every card's footer looks the same. */
  renderSaveBar: (dirty: boolean, section: string, onSave: () => void) => React.ReactNode;
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Default printer + per-printer job defaults. Electron-only: in the browser
 *  build the card explains why the list is empty. */
export const PrintersCard: React.FC<PrintersCardProps> = ({ currentSettings, onPersist, renderSaveBar }) => {
  const { isRtl } = useAdmin();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [engine, setEngine] = useState<PrintEngineInfo | null>(null);
  const [defaultPrinterName, setDefaultPrinterName] = useState<string>(currentSettings.defaultPrinterName || "");
  const [printerDefaults, setPrinterDefaults] = useState<Record<string, PrinterJobDefaults>>(
    currentSettings.printerDefaults || {},
  );

  const loadPrinters = React.useCallback(async () => {
    if (!isElectron()) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const list = await getPrinters();
      setPrinters(list);
    } catch (err) {
      setPrintersError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrintersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrinters();
  }, [loadPrinters]);

  // Surface which print engine is active. On the Chromium fallback the shop
  // should know that copies/duplex/paper size may be ignored by the driver.
  useEffect(() => {
    getPrintEngine().then(setEngine).catch(() => setEngine(null));
  }, []);

  // Re-baseline when the panel saves or reloads settings from the server.
  useEffect(() => {
    setDefaultPrinterName(currentSettings.defaultPrinterName || "");
    setPrinterDefaults(currentSettings.printerDefaults || {});
  }, [currentSettings.defaultPrinterName, currentSettings.printerDefaults]);

  const printersDirty =
    defaultPrinterName !== (currentSettings.defaultPrinterName || "") ||
    !eq(printerDefaults, currentSettings.printerDefaults || {});

  const savePrinters = () => onPersist("printers", { defaultPrinterName, printerDefaults });

  return (
    <Card className="lg:col-span-2 border-0">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center flex-shrink-0">
            <Icon name="print" className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-base">{isRtl ? "الطابعات" : "Printers"}</CardTitle>
            <CardDescription>{isRtl ? "اختر الطابعة الافتراضية واضبط إعدادات المهمة لكل طابعة" : "Choose a default printer and set per-printer job defaults"}</CardDescription>
          </div>
          <div className="ms-auto">
            <Button variant="outline" size="sm" onClick={loadPrinters} disabled={printersLoading} className="gap-2">
              <Icon name="refresh" className={cn("w-4 h-4", printersLoading && "animate-spin")} />
              {isRtl ? "تحديث" : "Refresh"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {engine && engine.engine !== "spooler" && (
          <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">
            {isRtl
              ? "محرك الطباعة الاحتياطي قيد الاستخدام: قد يتجاهل التعريف عدد النسخ والطباعة على الوجهين وحجم الورق. أعد تثبيت التطبيق لاستعادة محرك الطباعة الكامل."
              : "Running on the fallback print engine — the driver may ignore copies, duplex and paper size. Reinstall the app to restore the full print engine."}
          </p>
        )}
        {!isElectron() ? (
          <p className="text-sm text-muted-foreground">
            {isRtl
              ? "الطباعة الأصلية متاحة فقط داخل تطبيق سطح المكتب."
              : "Native printing is only available inside the desktop app."}
          </p>
        ) : printersError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{printersError}</p>
        ) : printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {printersLoading
              ? (isRtl ? "جارٍ اكتشاف الطابعات..." : "Detecting printers…")
              : (isRtl ? "لم يتم العثور على طابعات مثبتة." : "No installed printers were found.")}
          </p>
        ) : (
          <div className="space-y-4">
            {printers.map((p) => {
              const isDefault = defaultPrinterName === p.name;
              const d: PrinterJobDefaults = printerDefaults[p.name] || {
                duplexMode: "simplex",
                color: true,
                copies: 1,
                collate: true,
                landscape: false,
              };
              const patchDefaults = (patch: Partial<PrinterJobDefaults>) => {
                setPrinterDefaults((prev) => ({ ...prev, [p.name]: { ...d, ...patch } }));
              };
              return (
                <div
                  key={p.name}
                  className={cn(
                    "rounded-xl border p-4",
                    isDefault
                      ? "border-indigo-400 dark:border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20"
                      : "border-border",
                  )}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          {p.displayName || p.name}
                        </span>
                        {p.isDefault && (
                          <span className="text-xs uppercase tracking-wide px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                            {isRtl ? "افتراضي النظام" : "System default"}
                          </span>
                        )}
                        {isDefault && (
                          <span className="text-xs uppercase tracking-wide px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300">
                            {isRtl ? "الطباعة السريعة" : "Quick Print"}
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={isDefault ? "secondary" : "outline"}
                      onClick={() => setDefaultPrinterName(isDefault ? "" : p.name)}
                    >
                      {isDefault
                        ? (isRtl ? "الطابعة الافتراضية" : "Default printer")
                        : (isRtl ? "تعيين كافتراضية" : "Set as default")}
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                    <div>
                      <Label className="text-xs">{isRtl ? "الوجهين" : "Duplex"}</Label>
                      <Select
                        value={d.duplexMode}
                        onValueChange={(v) => patchDefaults({ duplexMode: v as PrinterJobDefaults["duplexMode"] })}
                      >
                        <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="simplex">{isRtl ? "وجه واحد" : "Single-sided"}</SelectItem>
                          <SelectItem value="longEdge">{isRtl ? "وجهين (الحافة الطويلة)" : "Two-sided (long edge)"}</SelectItem>
                          <SelectItem value="shortEdge">{isRtl ? "وجهين (الحافة القصيرة)" : "Two-sided (short edge)"}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">{isRtl ? "نسخ" : "Copies"}</Label>
                      <Input
                        type="number"
                        min={1}
                        className="mt-1"
                        value={d.copies}
                        onChange={(e) => patchDefaults({ copies: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                      />
                    </div>
                    <div className="flex flex-col justify-between gap-2">
                      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                        <Label className="text-xs cursor-pointer">{isRtl ? "ألوان" : "Color"}</Label>
                        <Switch checked={d.color} onCheckedChange={(c) => patchDefaults({ color: c })} />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                        <Label className="text-xs cursor-pointer">{isRtl ? "ترتيب" : "Collate"}</Label>
                        <Switch checked={d.collate} onCheckedChange={(c) => patchDefaults({ collate: c })} />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                        <Label className="text-xs cursor-pointer">{isRtl ? "أفقي" : "Landscape"}</Label>
                        <Switch checked={d.landscape} onCheckedChange={(c) => patchDefaults({ landscape: c })} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              {isRtl
                ? "تُستخدم هذه الإعدادات كنقطة بداية للطباعة السريعة ولمربع حوار خيارات الطباعة."
                : "These defaults are the starting point for Quick Print and pre-fill the Options print dialog."}
            </p>
          </div>
        )}
        {isElectron() && renderSaveBar(printersDirty, "printers", savePrinters)}
      </CardContent>
    </Card>
  );
};
