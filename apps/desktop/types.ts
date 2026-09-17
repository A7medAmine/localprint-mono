// Shared types live in @atba3li/shared/types. Only desktop-specific types
// (inventory — the online app has no stock tracking) are declared here.
export * from "@atba3li/shared/types";

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

/** Physical paper the credential card is printed on — thermal receipt rolls plus standard sheets. */
export type CardPaperSize = "thermal58" | "thermal80" | "a5" | "a4";

export interface Credential {
  id: string;
  customerName: string;
  serviceName: string;
  websiteUrl: string;
  username: string;
  /** "••••••••" from the list endpoint; the real value only from a single-record fetch. */
  password: string;
  /** Per-card override — printed instead of the shop-wide default notice when set. */
  notice: string;
  createdAt?: string;
}

/** A reusable "service" preset (CNAS, Gmail, ...) offered in the add-card dropdown. */
export interface CredentialServicePreset {
  id: string;
  name: string;
  /** Prefills the card's website field when this preset is picked — still editable per card. */
  websiteUrl: string;
}

/** How large the text prints on the card — the a4/a5 layout looks sparse at "normal" on a full sheet. */
export type CredentialCardFontScale = "normal" | "large" | "xlarge";

/** Shop-wide credential-card settings — service presets and the default notice. */
export interface CredentialSettings {
  services: CredentialServicePreset[];
  defaultNotice: string;
  fontScale: CredentialCardFontScale;
}
