/**
 * Pure summary math for the dashboard (unit tested; the route just loads
 * rows and calls this). Transfers/refunds never reach subscriptions rows,
 * and dismissed/cancelled streams are excluded here.
 */
import { centsToString, monthlyEquivalentCents } from "@/lib/money";
import type { Cadence, Verdict } from "@/modules/detection/engine/types";

export type SummaryStream = {
  status: "active" | "dismissed" | "cancelled";
  classification: "subscription" | "bill" | "habit" | null;
  verdict: Verdict | null;
  cadence: Cadence | null;
  currentAmount: string;
};

export type Summary = {
  monthly_recurring: string;
  currency: string;
  active_count: number;
  flags: {
    price_increased: number;
    likely_forgotten: number;
    probable_annual: number;
  };
  estimated_monthly_waste: string;
};

/**
 * Counted in the total: active, classified subscriptions with a non-question
 * verdict (asserted verdicts + probable_annual — real charges, real money).
 * Question streams are unresolved and never counted (invariant 5's spirit:
 * don't state totals built on unasserted claims).
 */
export function computeSummary(streams: SummaryStream[], currency = "CAD"): Summary {
  let totalCents = 0;
  let wasteCents = 0;
  let activeCount = 0;
  const flags = { price_increased: 0, likely_forgotten: 0, probable_annual: 0 };

  for (const s of streams) {
    if (s.status !== "active") continue;
    if (s.classification !== "subscription") continue;
    if (!s.cadence || !s.verdict || s.verdict === "question") continue;

    activeCount++;
    const monthly = monthlyEquivalentCents(s.currentAmount, s.cadence);
    totalCents += monthly;

    if (s.verdict === "price_increased") flags.price_increased++;
    if (s.verdict === "likely_forgotten") {
      flags.likely_forgotten++;
      wasteCents += monthly;
    }
    if (s.verdict === "probable_annual") flags.probable_annual++;
  }

  return {
    monthly_recurring: centsToString(totalCents),
    currency,
    active_count: activeCount,
    flags,
    estimated_monthly_waste: centsToString(wasteCents),
  };
}
