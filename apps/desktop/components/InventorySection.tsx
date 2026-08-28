import React, { useState, useEffect } from "react";
import { Language, PaperType, InventoryItem, InventoryAdjustment, InventoryCategory } from "../types";
import { storageService } from "../services/storageService";
import { toast } from "./ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";

interface InventorySectionProps {
  lang: Language;
  paperTypes: PaperType[];
  /** Lets the sidebar badge stay in sync without refetching. */
  onLowStockCountChange?: (count: number) => void;
}

interface ItemForm {
  name: string;
  category: InventoryCategory;
  unit: string;
  currentStock: number;
  lowStockThreshold: number;
  paperTypeId: string;
}

const EMPTY_FORM: ItemForm = {
  name: "",
  category: "paper",
  unit: "sheets",
  currentStock: 0,
  lowStockThreshold: 0,
  paperTypeId: "",
};

// Sentinel for the "no paper type linked" option — Radix Select treats "" as empty.
const NO_LINK = "__none__";

const CATEGORY_META: Record<InventoryCategory, { en: string; ar: string; icon: string; classes: string }> = {
  paper: {
    en: "Paper",
    ar: "الورق",
    icon: "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    classes: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400",
  },
  ink_toner: {
    en: "Ink & Toner",
    ar: "الحبر والمسحوق",
    icon: "M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01",
    classes: "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
  },
  custom: {
    en: "Other Supplies",
    ar: "مستلزمات أخرى",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    classes: "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400",
  },
};

const CATEGORY_ORDER: InventoryCategory[] = ["paper", "ink_toner", "custom"];

// Stock is stored as REAL so whole numbers would render as "500.0" without this.
const formatStock = (value: number) =>
  Number.isInteger(value) ? String(value) : String(parseFloat(value.toFixed(2)));

const InventorySection: React.FC<InventorySectionProps> = ({ lang, paperTypes, onLowStockCountChange }) => {
  const isRtl = lang === "ar";

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [itemForm, setItemForm] = useState<ItemForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<InventoryItem | null>(null);
  const [restockItem, setRestockItem] = useState<InventoryItem | null>(null);
  const [restockAmount, setRestockAmount] = useState<number>(0);
  const [restockNote, setRestockNote] = useState("");

  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [history, setHistory] = useState<InventoryAdjustment[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Per-item inline step size, so "+"/"−" can move more than one unit at a time.
  const [stepAmounts, setStepAmounts] = useState<Record<string, number>>({});
  const [adjustingId, setAdjustingId] = useState<string | null>(null);

  const loadInventory = async () => {
    try {
      const { items: loaded, lowStockCount } = await storageService.getInventory();
      setItems(loaded);
      onLowStockCountChange?.(lowStockCount);
    } catch (err) {
      console.error("Failed to load inventory:", err);
      toast({ title: isRtl ? "فشل تحميل المخزون" : "Failed to load inventory", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInventory();
  }, []);

  const isLow = (item: InventoryItem) =>
    item.lowStockThreshold > 0 && item.currentStock <= item.lowStockThreshold;

  const lowStockItems = items.filter(isLow);

  const getPaperTypeName = (id: string | null) => {
    if (!id) return null;
    const pt = paperTypes.find((p) => p.id === id);
    if (!pt) return null;
    return isRtl ? pt.nameAr : pt.name;
  };

  const openAddDialog = () => {
    setEditingItem(null);
    setItemForm(EMPTY_FORM);
    setItemDialogOpen(true);
  };

  const openEditDialog = (item: InventoryItem) => {
    setEditingItem(item);
    setItemForm({
      name: item.name,
      category: item.category,
      unit: item.unit,
      currentStock: item.currentStock,
      lowStockThreshold: item.lowStockThreshold,
      paperTypeId: item.paperTypeId || "",
    });
    setItemDialogOpen(true);
  };

  const handleSaveItem = async () => {
    if (!itemForm.name.trim()) {
      toast({ title: isRtl ? "الاسم مطلوب" : "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: itemForm.name.trim(),
        category: itemForm.category,
        unit: itemForm.unit.trim() || "units",
        currentStock: Number(itemForm.currentStock) || 0,
        lowStockThreshold: Number(itemForm.lowStockThreshold) || 0,
        // The server ignores this for non-paper categories, but don't send a
        // stale link either.
        paperTypeId: itemForm.category === "paper" ? itemForm.paperTypeId || null : null,
      };

      if (editingItem) {
        await storageService.updateInventoryItem(editingItem.id, payload);
        toast({ title: isRtl ? "تم تحديث العنصر" : "Item updated", variant: "success" });
      } else {
        await storageService.createInventoryItem(payload);
        toast({ title: isRtl ? "تمت إضافة العنصر" : "Item added", variant: "success" });
      }
      setItemDialogOpen(false);
      loadInventory();
    } catch (err: any) {
      toast({ title: isRtl ? "فشل الحفظ" : "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await storageService.deleteInventoryItem(deleteConfirm.id);
      toast({ title: isRtl ? "تم حذف العنصر" : "Item deleted", variant: "success" });
      loadInventory();
    } catch (err: any) {
      toast({ title: isRtl ? "فشل الحذف" : "Delete failed", description: err.message, variant: "destructive" });
    } finally {
      setDeleteConfirm(null);
    }
  };

  // Manual +/- always available, for every category, regardless of auto-deduct.
  const handleInlineAdjust = async (item: InventoryItem, direction: 1 | -1) => {
    const step = Math.abs(stepAmounts[item.id] ?? 1) || 1;
    setAdjustingId(item.id);
    try {
      const { item: updated } = await storageService.adjustInventoryStock(item.id, direction * step, "manual");
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      const { lowStockCount } = await storageService.getInventory();
      onLowStockCountChange?.(lowStockCount);
    } catch (err: any) {
      toast({ title: isRtl ? "فشل التعديل" : "Adjustment failed", description: err.message, variant: "destructive" });
    } finally {
      setAdjustingId(null);
    }
  };

  const handleRestock = async () => {
    if (!restockItem || !restockAmount) return;
    try {
      await storageService.adjustInventoryStock(
        restockItem.id,
        Math.abs(Number(restockAmount)),
        "restock",
        restockNote.trim() || undefined,
      );
      toast({ title: isRtl ? "تم تحديث المخزون" : "Stock restocked", variant: "success" });
      setRestockItem(null);
      setRestockAmount(0);
      setRestockNote("");
      loadInventory();
    } catch (err: any) {
      toast({ title: isRtl ? "فشل إعادة التعبئة" : "Restock failed", description: err.message, variant: "destructive" });
    }
  };

  const openHistory = async (item: InventoryItem) => {
    setHistoryItem(item);
    setHistoryLoading(true);
    try {
      setHistory(await storageService.getInventoryAdjustments(item.id, 100));
    } catch (err) {
      console.error("Failed to load adjustments:", err);
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const reasonLabel = (reason: string) => {
    if (reason === "restock") return isRtl ? "إعادة تعبئة" : "Restock";
    if (reason === "auto_deduct") return isRtl ? "خصم تلقائي" : "Auto-deduct";
    return isRtl ? "تعديل يدوي" : "Manual";
  };

  const reasonClasses = (reason: string) => {
    if (reason === "restock") return "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400";
    if (reason === "auto_deduct") return "bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400";
    return "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400";
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Page Header */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
            {isRtl ? "المخزون" : "Inventory"}
          </h2>
          <p className="text-gray-600 dark:text-gray-300 mt-1 text-sm sm:text-base">
            {isRtl
              ? "تتبع الورق والحبر والمستلزمات الأخرى"
              : "Track paper, ink & toner, and other shop supplies"}
          </p>
        </div>
        <Button onClick={openAddDialog} className="gap-2 shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
          </svg>
          {isRtl ? "إضافة عنصر" : "Add Item"}
        </Button>
      </div>

      {/* Low stock banner */}
      {!loading && lowStockItems.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <svg className="w-5 h-5 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              {lowStockItems.length} {isRtl ? "عنصر منخفض المخزون" : lowStockItems.length === 1 ? "item is low on stock" : "items are low on stock"}
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
              {lowStockItems.map((i) => i.name).join(isRtl ? "، " : ", ")}
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-4 animate-pulse">
          {[1, 2].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-6">
              <div className="h-4 w-40 rounded-full bg-gray-200 dark:bg-gray-700 mb-4" />
              <div className="space-y-2">
                <div className="h-10 rounded-lg bg-gray-100 dark:bg-gray-800" />
                <div className="h-10 rounded-lg bg-gray-100 dark:bg-gray-800" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-12 text-center bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
          <svg className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p className="text-gray-500 dark:text-gray-400">
            {isRtl ? "لا توجد عناصر في المخزون بعد" : "No inventory items yet"}
          </p>
          <Button variant="outline" onClick={openAddDialog} className="mt-4 gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            {isRtl ? "إضافة أول عنصر" : "Add your first item"}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {CATEGORY_ORDER.map((category) => {
            const categoryItems = items.filter((i) => i.category === category);
            if (categoryItems.length === 0) return null;
            const meta = CATEGORY_META[category];

            return (
              <Card key={category} className="border-0">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${meta.classes}`}>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={meta.icon} />
                      </svg>
                    </div>
                    <div>
                      <CardTitle className="text-base">{isRtl ? meta.ar : meta.en}</CardTitle>
                      <CardDescription>
                        {category === "paper"
                          ? isRtl
                            ? "يمكن ربطها بنوع ورق للخصم التلقائي"
                            : "Can be linked to a paper type for auto-deduct"
                          : isRtl
                            ? "تعديل يدوي فقط"
                            : "Manual adjustment only"}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead className="border-b border-gray-200 dark:border-gray-700">
                        <tr>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}>
                            {isRtl ? "العنصر" : "Item"}
                          </th>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}>
                            {isRtl ? "المخزون" : "Stock"}
                          </th>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider hidden sm:table-cell ${isRtl ? "text-right" : ""}`}>
                            {isRtl ? "حد التنبيه" : "Low at"}
                          </th>
                          <th className={`px-3 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider ${isRtl ? "text-right" : ""}`}>
                            {isRtl ? "تعديل" : "Adjust"}
                          </th>
                          <th className="px-3 py-2.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                            {isRtl ? "إجراءات" : "Actions"}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                        {categoryItems.map((item) => {
                          const low = isLow(item);
                          const linkedName = getPaperTypeName(item.paperTypeId);
                          const busy = adjustingId === item.id;

                          return (
                            <tr
                              key={item.id}
                              className={`transition-colors ${
                                low
                                  ? "bg-red-50/60 dark:bg-red-900/10 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  : "hover:bg-gray-50 dark:hover:bg-gray-800/60"
                              }`}
                            >
                              {/* Name + paper link */}
                              <td className="px-3 py-3 align-middle">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                    {item.name}
                                  </span>
                                  {low && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                                      {isRtl ? "منخفض" : "Low"}
                                    </span>
                                  )}
                                </div>
                                {item.category === "paper" && (
                                  <div className="mt-1">
                                    {linkedName ? (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m6.656-6.656l1.5-1.5a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656 0" />
                                        </svg>
                                        {linkedName}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                                        {isRtl ? "غير مرتبط" : "Not linked"}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>

                              {/* Stock */}
                              <td className="px-3 py-3 align-middle whitespace-nowrap">
                                <span className={`text-sm font-bold ${low ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
                                  {formatStock(item.currentStock)}
                                </span>
                                <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">{item.unit}</span>
                              </td>

                              {/* Threshold */}
                              <td className="px-3 py-3 align-middle whitespace-nowrap hidden sm:table-cell">
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {item.lowStockThreshold > 0 ? formatStock(item.lowStockThreshold) : "—"}
                                </span>
                              </td>

                              {/* Inline +/- */}
                              <td className="px-3 py-3 align-middle">
                                <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-0.5 shadow-sm dark:shadow-gray-900/50 w-max">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="w-6 h-6"
                                    disabled={busy}
                                    title={isRtl ? "إنقاص" : "Decrease"}
                                    onClick={() => handleInlineAdjust(item, -1)}
                                  >
                                    −
                                  </Button>
                                  <Input
                                    type="number"
                                    min={1}
                                    value={stepAmounts[item.id] ?? 1}
                                    onChange={(e) =>
                                      setStepAmounts((prev) => ({
                                        ...prev,
                                        [item.id]: Math.max(1, parseInt(e.target.value) || 1),
                                      }))
                                    }
                                    className="w-12 text-center text-xs font-semibold h-7 px-0"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="w-6 h-6"
                                    disabled={busy}
                                    title={isRtl ? "زيادة" : "Increase"}
                                    onClick={() => handleInlineAdjust(item, 1)}
                                  >
                                    +
                                  </Button>
                                </div>
                              </td>

                              {/* Actions */}
                              <td className="px-3 py-3 align-middle">
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-xs h-7 px-2 gap-1"
                                    title={isRtl ? "إعادة تعبئة" : "Restock"}
                                    onClick={() => {
                                      setRestockItem(item);
                                      setRestockAmount(0);
                                      setRestockNote("");
                                    }}
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                                    </svg>
                                    {isRtl ? "تعبئة" : "Restock"}
                                  </Button>
                                  <Button variant="ghost" size="icon" className="w-7 h-7" title={isRtl ? "السجل" : "History"} onClick={() => openHistory(item)}>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                  </Button>
                                  <Button variant="ghost" size="icon" className="w-7 h-7" title={isRtl ? "تعديل" : "Edit"} onClick={() => openEditDialog(item)}>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                    </svg>
                                  </Button>
                                  <Button variant="ghost" size="icon" className="w-7 h-7" title={isRtl ? "حذف" : "Delete"} onClick={() => setDeleteConfirm(item)}>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit Item Dialog */}
      <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingItem ? (isRtl ? "تعديل العنصر" : "Edit Item") : (isRtl ? "إضافة عنصر" : "Add Item")}
            </DialogTitle>
            <DialogDescription>
              {isRtl
                ? "حدد الاسم والفئة والوحدة والمخزون الحالي وحد التنبيه."
                : "Set the name, category, unit, current stock and low-stock threshold."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                {isRtl ? "الاسم" : "Name"}
              </label>
              <Input
                value={itemForm.name}
                onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                placeholder={isRtl ? "مثال: ورق A4 80 غرام" : "e.g. A4 80gsm paper"}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                  {isRtl ? "الفئة" : "Category"}
                </label>
                <Select
                  value={itemForm.category}
                  onValueChange={(val) =>
                    setItemForm((prev) => ({
                      ...prev,
                      category: val as InventoryCategory,
                      // Only paper items keep a link.
                      paperTypeId: val === "paper" ? prev.paperTypeId : "",
                      unit: prev.unit || (val === "paper" ? "sheets" : val === "ink_toner" ? "cartridges" : "units"),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_ORDER.map((c) => (
                      <SelectItem key={c} value={c}>
                        {isRtl ? CATEGORY_META[c].ar : CATEGORY_META[c].en}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                  {isRtl ? "الوحدة" : "Unit"}
                </label>
                <Input
                  value={itemForm.unit}
                  onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })}
                  placeholder={isRtl ? "ورقة، مل، وحدة..." : "sheets, ml, units..."}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                  {isRtl ? "المخزون الحالي" : "Current stock"}
                </label>
                <Input
                  type="number"
                  min={0}
                  value={itemForm.currentStock}
                  onChange={(e) => setItemForm({ ...itemForm, currentStock: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                  {isRtl ? "حد التنبيه" : "Low-stock threshold"}
                </label>
                <Input
                  type="number"
                  min={0}
                  value={itemForm.lowStockThreshold}
                  onChange={(e) => setItemForm({ ...itemForm, lowStockThreshold: parseFloat(e.target.value) || 0 })}
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {isRtl ? "0 يعني عدم التنبيه" : "0 means never warn"}
                </p>
              </div>
            </div>

            {/* Paper link — only relevant for paper items */}
            {itemForm.category === "paper" && (
              <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                  {isRtl ? "ربط بنوع ورق (اختياري)" : "Link to paper type (optional)"}
                </label>
                <Select
                  value={itemForm.paperTypeId || NO_LINK}
                  onValueChange={(val) => setItemForm({ ...itemForm, paperTypeId: val === NO_LINK ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={isRtl ? "بدون ربط" : "No link"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_LINK}>{isRtl ? "بدون ربط" : "No link"}</SelectItem>
                    {paperTypes.map((pt) => (
                      <SelectItem key={pt.id} value={pt.id}>
                        {isRtl ? pt.nameAr : pt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {isRtl
                    ? "عند تفعيل الخصم التلقائي، سيتم خصم (الصفحات × النسخ) من هذا العنصر عند تحديد الطلب كمطبوع."
                    : "With auto-deduct on, pages × copies is subtracted from this item when a job is marked printed."}
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setItemDialogOpen(false)}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button onClick={handleSaveItem} disabled={saving}>
              {saving ? (isRtl ? "جارٍ الحفظ..." : "Saving...") : (isRtl ? "حفظ" : "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restock Dialog */}
      <Dialog open={!!restockItem} onOpenChange={(open) => { if (!open) setRestockItem(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRtl ? "إعادة تعبئة المخزون" : "Restock"}</DialogTitle>
            <DialogDescription>
              {restockItem?.name}
              {restockItem ? ` — ${isRtl ? "الحالي" : "currently"} ${formatStock(restockItem.currentStock)} ${restockItem.unit}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                {isRtl ? "الكمية المضافة" : "Quantity to add"}
              </label>
              <Input
                type="number"
                min={1}
                autoFocus
                value={restockAmount || ""}
                onChange={(e) => setRestockAmount(parseFloat(e.target.value) || 0)}
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
                {isRtl ? "ملاحظة (اختياري)" : "Note (optional)"}
              </label>
              <Input
                value={restockNote}
                onChange={(e) => setRestockNote(e.target.value)}
                placeholder={isRtl ? "مثال: فاتورة المورد رقم 123" : "e.g. supplier invoice #123"}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestockItem(null)}>
              {isRtl ? "إلغاء" : "Cancel"}
            </Button>
            <Button onClick={handleRestock} disabled={!restockAmount}>
              {isRtl ? "إضافة" : "Add to stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={!!historyItem} onOpenChange={(open) => { if (!open) setHistoryItem(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRtl ? "سجل التعديلات" : "Adjustment History"}</DialogTitle>
            <DialogDescription>{historyItem?.name}</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {historyLoading ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
                {isRtl ? "جارٍ التحميل..." : "Loading..."}
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
                {isRtl ? "لا توجد تعديلات بعد" : "No adjustments yet"}
              </p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-white/10">
                {history.map((adj) => (
                  <div key={adj.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${reasonClasses(adj.reason)}`}>
                          {reasonLabel(adj.reason)}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {/* SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC — normalise to ISO before parsing. */}
                          {new Date(adj.createdAt.replace(" ", "T") + "Z").toLocaleString(isRtl ? "ar-EG" : "en-US", { numberingSystem: "latn" })}
                        </span>
                      </div>
                      {adj.note && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{adj.note}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <span className={`text-sm font-bold ${adj.amount < 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                        {adj.amount > 0 ? "+" : ""}{formatStock(adj.amount)}
                      </span>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">
                        → {formatStock(adj.stockAfter)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryItem(null)}>
              {isRtl ? "إغلاق" : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isRtl ? "حذف العنصر؟" : "Delete item?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isRtl
                ? `سيتم حذف "${deleteConfirm?.name}" وسجل تعديلاته. لا يمكن التراجع.`
                : `"${deleteConfirm?.name}" and its adjustment history will be deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRtl ? "إلغاء" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>
              {isRtl ? "حذف" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default InventorySection;
