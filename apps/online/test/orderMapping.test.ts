import { describe, it, expect } from "vitest";
import { ORDER_FIELD_MAP, toApiOrder, fromApiOrder } from "../utils/orderMapping.js";

// This round-trip is load-bearing: Phase 4.3 replaces the hand-built order
// serializers in server.js with these mappers, so the camelCase <-> column
// correspondence must be exact and lossless in both directions.
describe("order field mapping", () => {
  const apiOrder = {
    id: "o1",
    customerName: "Amine",
    phoneNumber: "0555000000",
    notes: "urgent",
    fileName: "cv.pdf",
    fileType: "application/pdf",
    fileSize: 1234,
    uploadDate: "2026-08-28T00:00:00Z",
    status: "PENDING",
    serverFileName: "abc123.pdf",
    pageCount: 3,
    colorMode: "color",
    copies: 2,
    paperType: "normal",
    totalPrice: 180,
    source: "web",
    shopSyncStatus: "synced",
    rejectionReason: "",
  };

  it("round-trips API -> db -> API losslessly", () => {
    expect(toApiOrder(fromApiOrder(apiOrder))).toEqual(apiOrder);
  });

  it("maps camelCase to the exact lowercase / snake columns", () => {
    const row = fromApiOrder(apiOrder);
    expect(row.customername).toBe("Amine");
    expect(row.phonenumber).toBe("0555000000");
    expect(row.pagecount).toBe(3);
    expect(row.total_price).toBe(180);
    expect(row.rejection_reason).toBe("");
    expect(row.shopsyncstatus).toBe("synced");
  });

  it("drops server-internal / unknown columns coming from the db", () => {
    const api = toApiOrder({
      id: "x",
      filename: "f.pdf",
      shop_id: "s1",
      user_id: "u1",
      delete_token_hash: "h",
      auth_deferred: true,
    } as Record<string, unknown>);
    expect(api).toEqual({ id: "x", fileName: "f.pdf" });
  });

  it("covers every mapped field in both directions", () => {
    for (const [api, db] of Object.entries(ORDER_FIELD_MAP)) {
      expect(fromApiOrder({ [api]: "v" })[db]).toBe("v");
      expect(toApiOrder({ [db]: "v" })[api]).toBe("v");
    }
  });
});
