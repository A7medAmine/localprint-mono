export enum PrintStatus {
  PENDING = "PENDING",
  READY = "READY",
  PRINTED = "PRINTED",
}

export enum PaymentStatus {
  UNPAID = "UNPAID",
  PAID = "PAID",
  PARTIAL = "PARTIAL",
}

export interface PrintJob {
  id: string;
  customerName: string;
  phoneNumber: string;
  notes: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadDate: string;
  status: PrintStatus;
  pageCount?: number;
  fileBlob?: Blob;
  serverFileName?: string;
  source?: string;
  paymentStatus?: PaymentStatus;
  paymentAmount?: number;
  paymentDate?: string;
  printPreferences?: {
    colorMode: "color" | "blackWhite";
    copies: number;
    paperType?: string;
  };
}

export interface PaperType {
  id: string;
  name: string;
  nameAr: string;
  colorPerPage: number;
  blackWhitePerPage: number;
}

export interface ShopSettings {
  shopName: string;
  logoUrl: string | null;
  pricing?: {
    colorPerPage: number;
    blackWhitePerPage: number;
    glossyPerPage?: number;
    cardboardPerPage?: number;
  };
  paperTypes?: PaperType[];
  phoneNumbers?: string[];
  email?: string;
  address?: string;
  workingHours?: string;
  returnPolicy?: string;
  cloudSyncUrl?: string;
  shopApiToken?: string;
  cloudSyncPollInterval?: string;
  autoAcceptCloudJobs?: boolean;
  autoDeductStock?: boolean;
  // Native printing (Electron). defaultPrinterName is Chromium's deviceName
  // for Quick Print; printerDefaults holds the pre-filled job settings per
  // printer, reused for both Quick Print and the Options dialog.
  defaultPrinterName?: string;
  printerDefaults?: Record<string, PrinterJobDefaults>;
}

export interface PrinterJobDefaults {
  duplexMode: "simplex" | "shortEdge" | "longEdge";
  color: boolean;
  copies: number;
  collate: boolean;
  landscape: boolean;
}

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

export type Language = "en" | "ar";

export interface Translations {
  [key: string]: {
    en: string;
    ar: string;
  };
}

export type DiscountType = "percent" | "fixed";
export type ConditionType = "pages" | "amount";

export interface DiscountRule {
  id: string;
  name: string;
  discount_type: DiscountType;
  discount_value: number;
  condition_type: ConditionType;
  threshold: number;
  max_discount_cap: number | null;
  priority: number;
  is_active: boolean;
  created_at?: string;
}

export interface DiscountResult {
  rule: DiscountRule | null;
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
  savingsPercentage: number;
}

export interface GmailAttachmentMeta {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface GmailPendingEmail {
  id: number;
  gmail_message_id: string;
  email_from: string;
  email_address: string;
  subject: string;
  body_preview: string;
  attachment_meta: GmailAttachmentMeta[];
  received_at: string;
  fetched_at: string;
}
