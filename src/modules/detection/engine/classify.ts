import { correctedGaps } from "./cadence";
import { coefficientOfVariation } from "./dates";
import type { Classification, EngineMerchant, PriorFeedback, Stream } from "./types";

/** Categories whose merchants bill amounts that vary with usage. */
const BILL_CATEGORIES = new Set(["telecom", "utility", "insurance", "government"]);

/** Categories that are near-certain subscriptions when charged on a cadence. */
const SUBSCRIPTION_CATEGORIES = new Set([
  "streaming",
  "music",
  "software",
  "cloud_storage",
  "news",
  "gym",
  "gaming",
  "dating",
  "education",
  "meal_kit",
  "food_delivery_membership",
  "finance",
]);

export type ClassifyResult = {
  classification: Classification;
  confidence: number;
};

/**
 * Weighted rule score — no ML (the fixture suite is the spec).
 *
 * Signals: amount consistency, interval tightness, known-merchant match,
 * merchant category, prior user feedback. Confidence caps at 0.99; a stream
 * below 0.80 is never asserted (invariant 5 — enforced again in verdicts).
 */
export function classify(
  stream: Stream,
  merchant: EngineMerchant | null,
  feedback: PriorFeedback[],
): ClassifyResult {
  const amounts = stream.amounts.map(Number);
  const amountCv = coefficientOfVariation(amounts);

  // Same missed-charge-tolerant gaps as detectCadence — one skipped month
  // shouldn't tank interval tightness.
  const gapCv = coefficientOfVariation(correctedGaps(stream.dates));

  // Score components in [0, 1].
  const amountConsistency = clamp01(1 - amountCv * 5);
  const intervalTightness = stream.cadence ? clamp01(1 - gapCv * 2.5) : 0;
  const knownMerchant = merchant ? 1 : 0;
  const category = merchant?.category && SUBSCRIPTION_CATEGORIES.has(merchant.category) ? 1 : 0;

  const merchantFeedback = feedback.filter(
    (f) => f.normalizedMerchant === stream.normalizedMerchant,
  );
  const positive = merchantFeedback.some((f) => f.userConfirmed);
  const negative = merchantFeedback.some((f) => !f.userConfirmed);

  let confidence =
    0.4 * amountConsistency +
    0.3 * intervalTightness +
    0.15 * knownMerchant +
    0.1 * category +
    (positive ? 0.05 : 0);
  if (negative) confidence -= 0.25; // negative merchant-match signal
  if (stream.dates.length < 3) confidence = Math.min(confidence, 0.79);
  confidence = clamp01(confidence);
  confidence = Math.min(confidence, 0.99);

  // Classification rules, most specific first.
  let classification: Classification = "subscription";
  if ((stream.cadence === "weekly" || stream.cadence === "biweekly") && !merchant) {
    // Frequent charges at an unknown merchant: a spending habit (coffee,
    // lunch), not a subscription.
    classification = "habit";
  } else if (merchant?.category && BILL_CATEGORIES.has(merchant.category)) {
    classification = "bill";
  } else if (amountCv > 0.06 && !category) {
    // Variable amounts on a cadence from a non-subscription merchant reads
    // like a usage-based bill, not a flat subscription.
    classification = "bill";
  }

  // Bills and habits are never asserted as subscriptions.
  if (classification !== "subscription") confidence = Math.min(confidence, 0.79);

  return { classification, confidence: round2(confidence) };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
