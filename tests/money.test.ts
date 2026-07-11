import { describe, expect, it } from "vitest";
import { centsToString, formatMoney, monthlyEquivalentCents, toCents } from "@/lib/money";
import { computeSummary } from "@/lib/summary";

describe("money math (integer cents, no floats)", () => {
  it("round-trips string amounts", () => {
    expect(toCents("18.99")).toBe(1899);
    expect(toCents("0.05")).toBe(5);
    expect(toCents("1200")).toBe(120000);
    expect(toCents("-5.40")).toBe(-540);
    expect(centsToString(1899)).toBe("18.99");
    expect(centsToString(5)).toBe("0.05");
    expect(centsToString(-540)).toBe("-5.40");
  });

  it("normalizes cadences to monthly equivalents", () => {
    expect(monthlyEquivalentCents("12.00", "monthly")).toBe(1200);
    expect(monthlyEquivalentCents("120.00", "annual")).toBe(1000);
    expect(monthlyEquivalentCents("30.00", "quarterly")).toBe(1000);
    expect(monthlyEquivalentCents("10.00", "weekly")).toBe(4333); // 10 × 52 / 12
    expect(monthlyEquivalentCents("10.00", "biweekly")).toBe(2167); // 10 × 26 / 12
    expect(monthlyEquivalentCents("20.00", "bimonthly")).toBe(1000);
  });

  it("formats for display", () => {
    expect(formatMoney("18.99")).toBe("$18.99");
    expect(formatMoney("18.99", "USD")).toBe("US$18.99");
  });
});

describe("summary math", () => {
  const base = {
    status: "active",
    classification: "subscription",
    verdict: "healthy",
  } as const;

  it("mixes cadences into a correct monthly total", () => {
    const summary = computeSummary([
      { ...base, cadence: "monthly", currentAmount: "18.99" },
      { ...base, cadence: "annual", currentAmount: "120.00" }, // 10.00/mo
      { ...base, cadence: "quarterly", currentAmount: "30.00" }, // 10.00/mo
      { ...base, cadence: "weekly", currentAmount: "3.00" }, // 13.00/mo
    ]);
    expect(summary.monthly_recurring).toBe("51.99");
    expect(summary.active_count).toBe(4);
  });

  it("excludes dismissed/cancelled streams, bills, habits, and questions", () => {
    const summary = computeSummary([
      { ...base, cadence: "monthly", currentAmount: "10.00" },
      { ...base, status: "dismissed", cadence: "monthly", currentAmount: "99.00" },
      { ...base, status: "cancelled", cadence: "monthly", currentAmount: "99.00" },
      { ...base, classification: "bill", cadence: "monthly", currentAmount: "99.00" },
      { ...base, classification: "habit", cadence: "weekly", currentAmount: "99.00" },
      { ...base, verdict: "question", cadence: "monthly", currentAmount: "99.00" },
    ]);
    expect(summary.monthly_recurring).toBe("10.00");
    expect(summary.active_count).toBe(1);
  });

  it("accrues cancelled subscriptions into total_saved, monthly-normalized", () => {
    const summary = computeSummary([
      { ...base, cadence: "monthly", currentAmount: "10.00" },
      { ...base, status: "cancelled", cadence: "monthly", currentAmount: "18.99" },
      { ...base, status: "cancelled", cadence: "annual", currentAmount: "120.00" }, // 10.00/mo
      // Dismissed is "not a subscription", never savings.
      { ...base, status: "dismissed", cadence: "monthly", currentAmount: "50.00" },
      // A cancelled BILL is not subscription savings either.
      {
        ...base,
        status: "cancelled",
        classification: "bill",
        cadence: "monthly",
        currentAmount: "40.00",
      },
    ]);
    expect(summary.total_saved).toBe("28.99");
    expect(summary.monthly_recurring).toBe("10.00");
  });

  it("counts flags and accrues likely-forgotten into waste", () => {
    const summary = computeSummary([
      { ...base, verdict: "price_increased", cadence: "monthly", currentAmount: "18.99" },
      { ...base, verdict: "likely_forgotten", cadence: "monthly", currentAmount: "12.00" },
      { ...base, verdict: "likely_forgotten", cadence: "annual", currentAmount: "120.00" },
      { ...base, verdict: "probable_annual", cadence: "annual", currentAmount: "99.00" },
    ]);
    expect(summary.flags).toEqual({
      price_increased: 1,
      likely_forgotten: 2,
      probable_annual: 1,
    });
    expect(summary.estimated_monthly_waste).toBe("22.00"); // 12 + 120/12
  });
});
