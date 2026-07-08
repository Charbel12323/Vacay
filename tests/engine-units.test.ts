import { describe, expect, it } from "vitest";
import { detectCadence } from "@/modules/detection/engine/cadence";
import { detectPriceChange } from "@/modules/detection/engine/price-change";
import { buildAliasIndex, normalizeMerchant } from "@/modules/detection/engine/normalize";
import type { Stream } from "@/modules/detection/engine/types";

function streamWith(dates: string[], amounts?: string[]): Stream {
  return {
    key: "acct:test:0",
    accountId: "acct",
    normalizedMerchant: "test",
    merchantId: null,
    merchantName: null,
    transactionIds: dates.map((_, i) => `t${i}`),
    dates,
    amounts: amounts ?? dates.map(() => "10.00"),
    currency: "CAD",
    currentAmount: amounts?.[amounts.length - 1] ?? "10.00",
    cadence: null,
    sameDayOfMonth: false,
    nextExpectedDate: null,
    classification: null,
    confidence: 0,
    verdict: null,
    firstChargeDate: dates[0]!,
    lastChargeDate: dates[dates.length - 1]!,
    suppressed: false,
  };
}

describe("detectCadence", () => {
  it("buckets median gaps per the stage table", () => {
    expect(detectCadence(streamWith(["2026-01-01", "2026-01-08", "2026-01-15"])).cadence).toBe(
      "weekly",
    );
    expect(detectCadence(streamWith(["2026-01-01", "2026-01-15", "2026-01-29"])).cadence).toBe(
      "biweekly",
    );
    expect(detectCadence(streamWith(["2026-01-01", "2026-03-02", "2026-05-01"])).cadence).toBe(
      "bimonthly",
    );
    expect(detectCadence(streamWith(["2025-01-10", "2025-04-10", "2025-07-10"])).cadence).toBe(
      "quarterly",
    );
    expect(detectCadence(streamWith(["2023-06-01", "2024-06-01", "2025-06-01"])).cadence).toBe(
      "annual",
    );
  });

  it("returns null for fewer than 3 charges outside the annual band", () => {
    expect(detectCadence(streamWith(["2026-01-01", "2026-02-01"])).cadence).toBeNull();
    expect(detectCadence(streamWith(["2026-01-01"])).cadence).toBeNull();
  });

  it("detects annual from exactly 2 charges a year apart", () => {
    const result = detectCadence(streamWith(["2024-08-15", "2025-08-15"]));
    expect(result.cadence).toBe("annual");
    expect(result.nextExpectedDate).toBe("2026-08-15");
  });

  it("returns null for erratic gaps", () => {
    expect(
      detectCadence(streamWith(["2026-01-01", "2026-01-12", "2026-02-20", "2026-03-01"])).cadence,
    ).toBeNull();
  });

  it("tolerates exactly one doubled gap (missed month)", () => {
    const result = detectCadence(
      streamWith(["2026-01-05", "2026-02-05", "2026-04-05", "2026-05-05"]),
    );
    expect(result.cadence).toBe("monthly");
    expect(result.sameDayOfMonth).toBe(true);
  });
});

describe("detectPriceChange", () => {
  it("ignores a one-off odd charge that reverts", () => {
    const stream = streamWith(
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"],
      ["16.99", "18.99", "16.99", "16.99"],
    );
    expect(detectPriceChange(stream)).toBeNull();
  });

  it("ignores sub-1% wobble", () => {
    const stream = streamWith(
      ["2026-01-15", "2026-02-15", "2026-03-15"],
      ["100.00", "100.00", "100.50"],
    );
    expect(detectPriceChange(stream)).toBeNull();
  });

  it("detects a persistent step and its effective date", () => {
    const stream = streamWith(
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"],
      ["16.99", "16.99", "16.99", "18.99", "18.99"],
    );
    expect(detectPriceChange(stream)).toEqual({
      streamKey: "acct:test:0",
      oldAmount: "16.99",
      newAmount: "18.99",
      effectiveDate: "2026-04-15",
    });
  });

  it("detects price decreases too", () => {
    const stream = streamWith(
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"],
      ["18.99", "18.99", "15.99", "15.99"],
    );
    expect(detectPriceChange(stream)?.newAmount).toBe("15.99");
  });
});

describe("normalizeMerchant alias matching", () => {
  const index = buildAliasIndex([
    {
      id: "m1",
      name: "Netflix",
      aliases: ["netflix.com"],
      category: "streaming",
      knownPlans: [],
    },
    { id: "m2", name: "Apple TV+", aliases: ["apple tv"], category: "streaming", knownPlans: [] },
  ]);

  it("canonicalizes processor-prefixed descriptors to the merchant", () => {
    const match = normalizeMerchant("PAYPAL *NETFLIX.COM 4029357733 CA", index);
    expect(match.normalized).toBe("netflix");
    expect(match.merchant?.name).toBe("Netflix");
  });

  it("prefers the longest alias on substring matches", () => {
    const match = normalizeMerchant("APPLE TV SUBSCRIPTION", index);
    expect(match.merchant?.name).toBe("Apple TV+");
  });

  it("passes through unknown merchants stripped", () => {
    const match = normalizeMerchant("LATTE HOUSE #42 TORONTO ON", index);
    expect(match.normalized).toBe("latte house toronto");
    expect(match.merchant).toBeNull();
  });
});
