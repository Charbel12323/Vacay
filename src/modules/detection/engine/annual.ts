import { addMonthsClamped } from "./dates";
import type { Stream } from "./types";

const ANNUAL_MARKERS = /\b(annual|yearly|12 ?mo|1 ?yr|year)\b/i;

/**
 * Single-charge probable annuals: a lone charge that matches a known
 * merchant's annual plan price (±5%) or carries annual/yearly markers in the
 * descriptor. Verdict `probable_annual`, confidence capped at 0.75 — it
 * surfaces as a question, never a verdict (invariant 5).
 */
export function detectAnnualSingle(
  stream: Stream,
  merchantKnownPlans: Array<{ amount: string; cadence: string }> | null,
  rawDescriptor: string,
): Stream | null {
  if (stream.dates.length !== 1) return null;

  const amount = Number(stream.currentAmount);
  const planMatch = (merchantKnownPlans ?? []).some(
    (p) => p.cadence === "annual" && Math.abs(amount - Number(p.amount)) / Number(p.amount) <= 0.05,
  );
  const markerMatch = ANNUAL_MARKERS.test(rawDescriptor);
  if (!planMatch && !markerMatch) return null;

  const confidence = Math.min(planMatch ? 0.75 : 0.6, 0.75);
  return {
    ...stream,
    cadence: "annual",
    classification: "subscription",
    confidence,
    verdict: "probable_annual",
    nextExpectedDate: addMonthsClamped(stream.lastChargeDate, 12),
  };
}
