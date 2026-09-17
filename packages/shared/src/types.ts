// Types shared by both apps. App-specific types stay in each app's local
// types.ts, which re-exports everything here. Client/TypeScript-only (never
// imported by the plain-Node servers), so this is a .ts module reached via the
// package's root specifier / the "@atba3li/shared/types" path.

export enum PrintStatus {
  PENDING = "PENDING",
  READY = "READY",
  PRINTED = "PRINTED",
  CANCELED = "CANCELED",
}

export enum PaymentStatus {
  UNPAID = "UNPAID",
  PAID = "PAID",
  PARTIAL = "PARTIAL",
}

export interface PrintJob {
  id: string;
  /**
   * Shared by every file from one upload submission, so the admin groups
   * them as a single order even when the files finish uploading — and so
   * arrive at the server — at different times.
   */
  orderId?: string;
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
  /**
   * Anti-abuse identifiers the online app captured when the customer uploaded,
   * carried down by cloud sync. Present only on cloud-sourced jobs; the Admin
   * panel uses them for "block this uploader".
   */
  uploaderIp?: string | null;
  uploaderFingerprint?: string | null;
  paymentStatus?: PaymentStatus;
  paymentAmount?: number;
  paymentDate?: string;
  printPreferences?: {
    colorMode: "color" | "blackWhite";
    copies: number;
    paperType?: string;
  };
}

/** One row of a shop's upload blocklist (online `blocked_uploaders`). */
export interface BlockedUploader {
  id: string;
  kind: "ip" | "fingerprint" | "phone" | "user";
  value: string;
  /** Operator's note. */
  reason: string;
  /** Who this was, at block time — kept readable after the order is gone. */
  label: string;
  createdAt: string;
}

export interface PaperType {
  id: string;
  name: string;
  nameAr: string;
  colorPerPage: number;
  blackWhitePerPage: number;
}

export type { ShopLocation, LocationSource, Coordinates } from "./geo";
import type { ShopLocation } from "./geo";
export type { SocialLinks, SocialPlatformId, SocialPlatform } from "./social";
import type { SocialLinks } from "./social";

// ShopSettings is the desktop superset: the online app uses only the common
// fields (shopName…returnPolicy, currency), and every desktop-only field below
// is optional, so online object literals still satisfy the type unchanged.
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
  /** Short "about the shop" blurb shown on the storefront card and the upload footer. */
  description?: string;
  /** Platform id → https URL. Only the platforms the shop actually filled. */
  socialLinks?: SocialLinks;
  /**
   * Where the shop physically is, as picked on the map / parsed from a map
   * link / read off GPS. Separate from `address`, which is the human-readable
   * street line and stays the thing a customer reads.
   */
  location?: ShopLocation | null;
  /** ISO-ish currency label shown next to prices (e.g. "DZD", "USD"). */
  currency?: string;
  cloudSyncUrl?: string;
  /** Storefront slug on the cloud platform, cached from the settings sync. */
  cloudShopSlug?: string;
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
