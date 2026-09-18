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

/** The CV document's own language — independent of the app's ar/en chrome language. */
export type CvLanguage = "ar" | "en" | "fr";
export type CvTemplateId = "modern" | "classic" | "minimal" | "azure";

/** One experience/education row. */
export interface CvEntry {
  id: string;
  title: string;
  subtitle: string;
  period: string;
  description: string;
}

/** A fully freeform extra section, beyond the fixed fields. */
export interface CvCustomSection {
  id: string;
  title: string;
  content: string;
}

export interface CvDocument {
  language: CvLanguage;
  templateId: CvTemplateId;
  /** Per-block visibility — off hides the block from the printed output without discarding its data. */
  fields: {
    photo: boolean;
    contact: boolean;
    summary: boolean;
    experience: boolean;
    education: boolean;
    skills: boolean;
    languages: boolean;
  };
  jobTitle: string;
  email: string;
  address: string;
  summary: string;
  experience: CvEntry[];
  education: CvEntry[];
  skills: string[];
  languagesSpoken: string[];
  customSections: CvCustomSection[];
}

export interface CvProfile {
  id: string;
  fullName: string;
  phone: string;
  photoFilename: string;
  data: CvDocument;
  createdAt?: string;
  updatedAt?: string;
}
