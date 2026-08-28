// Shared types live in @localprint/shared/types. Only desktop-specific types
// (inventory — the online app has no stock tracking) are declared here.
export * from "@localprint/shared/types";

export type InventoryCategory = "paper" | "ink_toner" | "custom";
export type InventoryReason = "manual" | "restock" | "auto_deduct";

export interface InventoryItem {
  id: string;
  name: string;
  category: InventoryCategory;
  unit: string;
  currentStock: number;
  lowStockThreshold: number;
  /** Only meaningful for category "paper" — enables auto-deduct on printed jobs. */
  paperTypeId: string | null;
  sortOrder: number;
  createdAt?: string;
}

export interface InventoryAdjustment {
  id: number;
  itemId: string;
  amount: number;
  reason: InventoryReason;
  note: string;
  jobId: string | null;
  stockAfter: number;
  createdAt: string;
}
