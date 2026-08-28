import { describe, it, expect } from "vitest";
import {
  calculatePrintPrice,
  calculateJobDiscount,
  calculateCustomerTotalWithDiscounts,
  formatPrice,
  DEFAULT_PAPER_TYPES,
} from "../utils/pricingUtils";
import { PrintStatus } from "../types";
import type { PrintJob, ShopSettings, DiscountRule } from "../types";

const job = (over: Partial<PrintJob> = {}): PrintJob => ({
  id: "j1",
  customerName: "A",
  phoneNumber: "0",
  notes: "",
  fileName: "f.pdf",
  fileType: "application/pdf",
  fileSize: 1,
  uploadDate: "2026-08-28",
  status: PrintStatus.PENDING,
  printPreferences: { colorMode: "color", copies: 1, paperType: "normal" },
  ...over,
});

const settings = (over: Partial<ShopSettings> = {}): ShopSettings => ({
  shopName: "Shop",
  logoUrl: null,
  pricing: { colorPerPage: 30, blackWhitePerPage: 15 },
  ...over,
});

const rule = (over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: "r1",
  name: "R",
  discount_type: "percent",
  discount_value: 10,
  condition_type: "pages",
  threshold: 5,
  max_discount_cap: null,
  priority: 1,
  is_active: true,
  ...over,
});

describe("calculatePrintPrice", () => {
  it("prices color pages at the pricing default when no paperTypes are set", () => {
    const r = calculatePrintPrice(job(), settings(), 3);
    expect(r.pricePerPage).toBe(30);
    expect(r.totalPages).toBe(3);
    expect(r.totalPrice).toBe(90);
    expect(r.currency).toBe("DZD");
  });

  it("uses the black-and-white rate and multiplies by copies", () => {
    const r = calculatePrintPrice(
      job({ printPreferences: { colorMode: "blackWhite", copies: 2, paperType: "normal" } }),
      settings(),
      4,
    );
    expect(r.pricePerPage).toBe(15);
    expect(r.totalPages).toBe(8);
    expect(r.totalPrice).toBe(120);
  });

  it("honors a matching custom paper type over the pricing defaults", () => {
    const r = calculatePrintPrice(
      job({ printPreferences: { colorMode: "color", copies: 1, paperType: "glossy" } }),
      settings({ paperTypes: DEFAULT_PAPER_TYPES({ colorPerPage: 30, blackWhitePerPage: 15 }) }),
      2,
    );
    expect(r.pricePerPage).toBe(50);
    expect(r.totalPrice).toBe(100);
  });
});

describe("calculateJobDiscount", () => {
  it("returns no discount when there are no rules", () => {
    const r = calculateJobDiscount(job(), 100, 3, []);
    expect(r.discountAmount).toBe(0);
    expect(r.finalAmount).toBe(100);
    expect(r.rule).toBeNull();
  });

  it("applies a percentage discount once the page threshold is met", () => {
    const r = calculateJobDiscount(job(), 200, 10, [rule({ discount_value: 10 })]);
    expect(r.discountAmount).toBe(20);
    expect(r.finalAmount).toBe(180);
  });

  it("caps a percentage discount at max_discount_cap", () => {
    const r = calculateJobDiscount(job(), 1000, 10, [rule({ discount_value: 50, max_discount_cap: 100 })]);
    expect(r.discountAmount).toBe(100);
    expect(r.finalAmount).toBe(900);
  });

  it("never lets a fixed discount push the final below zero", () => {
    const r = calculateJobDiscount(job(), 30, 10, [rule({ discount_type: "fixed", discount_value: 50 })]);
    expect(r.discountAmount).toBe(30);
    expect(r.finalAmount).toBe(0);
  });

  it("ignores inactive rules", () => {
    const r = calculateJobDiscount(job(), 200, 10, [rule({ is_active: false })]);
    expect(r.rule).toBeNull();
  });

  it("skips a rule whose threshold is not met", () => {
    const r = calculateJobDiscount(job(), 200, 3, [rule({ condition_type: "pages", threshold: 5 })]);
    expect(r.rule).toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats with two decimals and the default currency", () => {
    expect(formatPrice(90)).toBe("90.00 DZD");
  });

  it("honors an explicit currency", () => {
    expect(formatPrice(12.5, "USD")).toBe("12.50 USD");
  });
});

describe("calculateCustomerTotalWithDiscounts", () => {
  it("sums originals, discounts, and finals across jobs", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const pageCounts = { a: 10, b: 10 };
    const rules = [rule({ discount_value: 10 })];
    const r = calculateCustomerTotalWithDiscounts(jobs, settings(), pageCounts, rules);
    // each job: 30 * 10 = 300 original, 10% -> 30 discount, 270 final
    expect(r.originalTotal).toBe(600);
    expect(r.totalDiscount).toBe(60);
    expect(r.finalTotal).toBe(540);
    expect(r.jobBreakdown).toHaveLength(2);
  });
});
