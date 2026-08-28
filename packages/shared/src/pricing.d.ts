// Type declarations for pricing.js (which is plain .js so the Node servers can
// import it). Keeps the TypeScript clients fully typed.
import type { PrintJob, ShopSettings, DiscountRule, DiscountResult, PaperType } from "./types";

export interface PriceCalculation {
  pricePerPage: number;
  totalPages: number;
  totalPrice: number;
  currency: string;
}

export function DEFAULT_PAPER_TYPES(pricing?: {
  colorPerPage: number;
  blackWhitePerPage: number;
  glossyPerPage?: number;
  cardboardPerPage?: number;
}): PaperType[];

export function calculatePrintPrice(
  job: PrintJob,
  settings: ShopSettings,
  actualPages?: number,
): PriceCalculation;

export function countPdfPages(file: File): Promise<number>;
export function countWordPages(file: File): Promise<number>;
export function getActualPageCount(file: File): Promise<number>;

export function formatPrice(price: number, currency?: string): string;

export function calculateCustomerTotal(
  jobs: PrintJob[],
  settings: ShopSettings,
  pageCounts: { [jobId: string]: number },
): number;

/**
 * Thin typed wrapper around the shared discount math. The `job` argument is
 * unused today but kept in the signature so future rules can gate on job
 * attributes without churning every call site.
 */
export function calculateJobDiscount(
  job: PrintJob,
  originalPrice: number,
  pageCount: number,
  rules: DiscountRule[],
): DiscountResult;

export function calculateCustomerTotalWithDiscounts(
  jobs: PrintJob[],
  settings: ShopSettings,
  pageCounts: { [jobId: string]: number },
  rules: DiscountRule[],
): {
  originalTotal: number;
  totalDiscount: number;
  finalTotal: number;
  jobBreakdown: { job: PrintJob; original: number; discount: number; final: number; rule: DiscountRule | null }[];
};
