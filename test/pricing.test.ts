import { describe, it, expect } from "vitest";
import { calculatePrintPrice } from "../utils/pricingUtils";
import { calculateJobDiscount } from "../utils/discountLogic.js";
import type { PrintJob, ShopSettings, DiscountRule } from "../types";

// ── Characterization tests: capture the CURRENT client pricing math so Phase
// 4.2's single shared calculator must reproduce it exactly. Do not "fix"
// pricing here — only record what it does today.

function makeJob(pref?: Partial<NonNullable<PrintJob["printPreferences"]>>): PrintJob {
  return {
    id: "job-1",
    customerName: "Test",
    phoneNumber: "0",
    notes: "",
    fileName: "f.pdf",
    fileType: "application/pdf",
    fileSize: 1,
    uploadDate: "2026-01-01T00:00:00.000Z",
    status: "PENDING" as PrintJob["status"],
    printPreferences: pref
      ? { colorMode: "color", copies: 1, ...pref }
      : undefined,
  };
}

const settings: ShopSettings = {
  shopName: "Shop",
  logoUrl: null,
  pricing: { colorPerPage: 30, blackWhitePerPage: 15, glossyPerPage: 50, cardboardPerPage: 40 },
};

describe("calculatePrintPrice", () => {
  const cases: Array<[string, ReturnType<typeof makeJob>, number, { pricePerPage: number; totalPages: number; totalPrice: number }]> = [
    ["normal/color 3p x2", makeJob({ paperType: "normal", colorMode: "color", copies: 2 }), 3, { pricePerPage: 30, totalPages: 6, totalPrice: 180 }],
    ["normal/bw 1p x1", makeJob({ paperType: "normal", colorMode: "blackWhite", copies: 1 }), 1, { pricePerPage: 15, totalPages: 1, totalPrice: 15 }],
    ["glossy/color", makeJob({ paperType: "glossy", colorMode: "color", copies: 1 }), 2, { pricePerPage: 50, totalPages: 2, totalPrice: 100 }],
    ["glossy/bw (same as color for glossy default)", makeJob({ paperType: "glossy", colorMode: "blackWhite", copies: 1 }), 2, { pricePerPage: 50, totalPages: 2, totalPrice: 100 }],
    ["cardboard/color", makeJob({ paperType: "cardboard", colorMode: "color", copies: 1 }), 1, { pricePerPage: 40, totalPages: 1, totalPrice: 40 }],
    ["unknown paperType falls back to pricing.color", makeJob({ paperType: "xyz", colorMode: "color", copies: 1 }), 1, { pricePerPage: 30, totalPages: 1, totalPrice: 30 }],
    ["unknown paperType bw falls back to pricing.bw", makeJob({ paperType: "xyz", colorMode: "blackWhite", copies: 1 }), 1, { pricePerPage: 15, totalPages: 1, totalPrice: 15 }],
    ["no printPreferences → normal/color/1", makeJob(), 4, { pricePerPage: 30, totalPages: 4, totalPrice: 120 }],
  ];

  for (const [name, job, actualPages, expected] of cases) {
    it(name, () => {
      const r = calculatePrintPrice(job, settings, actualPages);
      expect(r.pricePerPage).toBe(expected.pricePerPage);
      expect(r.totalPages).toBe(expected.totalPages);
      expect(r.totalPrice).toBe(expected.totalPrice);
      expect(r.currency).toBe("DZD");
    });
  }

  it("honors an explicit paperTypes override", () => {
    const custom: ShopSettings = {
      ...settings,
      paperTypes: [{ id: "normal", name: "N", nameAr: "ن", colorPerPage: 99, blackWhitePerPage: 11 }],
    };
    const r = calculatePrintPrice(makeJob({ paperType: "normal", colorMode: "color", copies: 1 }), custom, 1);
    expect(r.totalPrice).toBe(99);
  });
});

// DiscountRule factory — all snake_case DB fields, casts for the string unions.
function rule(p: Partial<DiscountRule>): DiscountRule {
  return {
    id: "r",
    name: "rule",
    discount_type: "percent" as DiscountRule["discount_type"],
    discount_value: 10,
    condition_type: "amount" as DiscountRule["condition_type"],
    threshold: 0,
    max_discount_cap: null,
    priority: 1,
    is_active: true,
    ...p,
  };
}

describe("calculateJobDiscount", () => {
  it("no rules → no discount", () => {
    const r = calculateJobDiscount(200, 6, []);
    expect(r.discountAmount).toBe(0);
    expect(r.finalAmount).toBe(200);
    expect(r.rule).toBeNull();
  });

  it("percent rule on amount threshold", () => {
    const r = calculateJobDiscount(200, 6, [rule({ condition_type: "amount" as DiscountRule["condition_type"], threshold: 100, discount_type: "percent" as DiscountRule["discount_type"], discount_value: 10 })]);
    expect(r.discountAmount).toBe(20);
    expect(r.finalAmount).toBe(180);
    expect(r.savingsPercentage).toBe(10);
  });

  it("percent capped by max_discount_cap", () => {
    const r = calculateJobDiscount(200, 6, [rule({ threshold: 0, discount_value: 50, max_discount_cap: 15 })]);
    expect(r.discountAmount).toBe(15);
  });

  it("fixed discount clamped to original price", () => {
    const r = calculateJobDiscount(30, 1, [rule({ discount_type: "fixed" as DiscountRule["discount_type"], discount_value: 50, threshold: 0 })]);
    expect(r.discountAmount).toBe(30);
    expect(r.finalAmount).toBe(0);
  });

  it("pages condition met vs not met", () => {
    const rules = [rule({ condition_type: "pages" as DiscountRule["condition_type"], threshold: 5, discount_type: "fixed" as DiscountRule["discount_type"], discount_value: 5 })];
    expect(calculateJobDiscount(100, 6, rules).discountAmount).toBe(5);
    expect(calculateJobDiscount(100, 3, rules).discountAmount).toBe(0);
  });

  it("inactive rule is ignored", () => {
    const r = calculateJobDiscount(200, 6, [rule({ threshold: 0, is_active: false })]);
    expect(r.discountAmount).toBe(0);
  });

  it("higher priority rule wins", () => {
    const lo = rule({ id: "lo", threshold: 0, discount_type: "fixed" as DiscountRule["discount_type"], discount_value: 50, priority: 1 });
    const hi = rule({ id: "hi", threshold: 0, discount_type: "fixed" as DiscountRule["discount_type"], discount_value: 10, priority: 5 });
    const r = calculateJobDiscount(200, 6, [lo, hi]);
    expect(r.rule?.id).toBe("hi");
    expect(r.discountAmount).toBe(10);
  });
});
