import { describe, expect, it } from "vitest";
import {
  isCountable,
  isRefund,
  isTransfer,
  normalizeMerchantBasic,
} from "@/modules/connections/normalize";

describe("normalizeMerchantBasic", () => {
  it("strips processor prefixes", () => {
    expect(normalizeMerchantBasic("SQ *BLUE BOTTLE COFFEE")).toBe("blue bottle coffee");
    expect(normalizeMerchantBasic("PAYPAL *NETFLIX.COM")).toBe("netflix.com");
    expect(normalizeMerchantBasic("APL* ITUNES.COM/BILL")).toBe("itunes.com/bill");
  });

  it("strips phone numbers, store numbers, and long digit runs", () => {
    expect(normalizeMerchantBasic("NETFLIX.COM 866-579-7172")).toBe("netflix.com");
    expect(normalizeMerchantBasic("TIM HORTONS #1234")).toBe("tim hortons");
    expect(normalizeMerchantBasic("SPOTIFY P0123456789")).toContain("spotify");
  });

  it("strips trailing province codes and collapses whitespace", () => {
    expect(normalizeMerchantBasic("GOODLIFE FITNESS   TORONTO ON")).toBe(
      "goodlife fitness toronto",
    );
  });

  it("keeps the raw descriptor unmodified elsewhere (pure function)", () => {
    const raw = "SQ *COFFEE #99 416-555-0100 ON";
    normalizeMerchantBasic(raw);
    expect(raw).toBe("SQ *COFFEE #99 416-555-0100 ON");
  });
});

describe("transfer/refund flagging", () => {
  const base = {
    amount: 50,
    pfcPrimary: null,
    pfcDetailed: null,
    legacyCategories: [] as string[],
  };

  it("flags PFC transfers and credit card payments", () => {
    expect(isTransfer({ ...base, pfcPrimary: "TRANSFER_OUT" })).toBe(true);
    expect(isTransfer({ ...base, pfcPrimary: "TRANSFER_IN" })).toBe(true);
    expect(isTransfer({ ...base, pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" })).toBe(true);
    expect(isTransfer({ ...base, legacyCategories: ["Transfer"] })).toBe(true);
    expect(isTransfer({ ...base, legacyCategories: ["Payment"] })).toBe(true);
    expect(isTransfer({ ...base, pfcPrimary: "FOOD_AND_DRINK" })).toBe(false);
  });

  it("flags refunds only for inflows with a recent matching charge", () => {
    const inflow = { ...base, amount: -15.99 };
    expect(isRefund(inflow, true)).toBe(true);
    expect(isRefund(inflow, false)).toBe(false);
    expect(isRefund({ ...base, amount: 15.99 }, true)).toBe(false);
    expect(isRefund({ ...inflow, pfcPrimary: "TRANSFER_IN" }, true)).toBe(false);
  });

  it("excludes transfers, refunds, and pending rows from aggregations", () => {
    expect(isCountable({ isTransfer: false, isRefund: false, pending: false })).toBe(true);
    expect(isCountable({ isTransfer: true, isRefund: false, pending: false })).toBe(false);
    expect(isCountable({ isTransfer: false, isRefund: true, pending: false })).toBe(false);
    expect(isCountable({ isTransfer: false, isRefund: false, pending: true })).toBe(false);
  });
});
