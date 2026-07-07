import { detectAnnualSingle } from "./annual";
import { detectCadence } from "./cadence";
import { classify } from "./classify";
import { daysBetween } from "./dates";
import { buildAliasIndex } from "./normalize";
import { detectPriceChange } from "./price-change";
import { groupStreams } from "./streams";
import type { EngineEvent, EngineInput, EngineOutput, PriceChange, Stream } from "./types";

export type { EngineInput, EngineOutput } from "./types";
export { ASSERTED_VERDICTS } from "./types";

/** Days past next_expected_date before a charge counts as missed. */
const MISSED_GRACE_DAYS = 5;
/** Renewal alert window for annual/quarterly cadences. */
const RENEWAL_WINDOW_DAYS = 30;
/** Tenure after which an unconfirmed subscription MAY read as forgotten. */
const FORGOTTEN_TENURE_DAYS = 365;
/** Categories people commonly keep paying for without using. */
const FORGETTABLE_CATEGORIES = new Set(["news", "gym", "dating", "education", "gaming"]);

/**
 * The whole engine: transactions + merchants + feedback → streams, price
 * changes, events. Pure and deterministic: same input, same output — it
 * re-derives everything from the transactions table every run (invariant 4).
 */
export function runEngine(input: EngineInput): EngineOutput {
  const aliasIndex = buildAliasIndex(input.merchants);
  const merchantById = new Map(input.merchants.map((m) => [m.id, m]));
  const txnById = new Map(input.transactions.map((t) => [t.id, t]));

  const streams: Stream[] = [];
  const priceChanges: PriceChange[] = [];
  const events: EngineEvent[] = [];

  for (const raw of groupStreams(input.transactions, aliasIndex)) {
    let stream = raw;
    const merchant = stream.merchantId ? (merchantById.get(stream.merchantId) ?? null) : null;

    if (stream.dates.length === 1) {
      const annual = detectAnnualSingle(
        stream,
        merchant?.knownPlans ?? null,
        txnById.get(stream.transactionIds[0]!)?.rawDescriptor ?? "",
      );
      if (!annual) continue; // lone charges with no annual signal aren't streams
      stream = annual;
    } else {
      const cadence = detectCadence(stream);
      stream = {
        ...stream,
        cadence: cadence.cadence,
        sameDayOfMonth: cadence.sameDayOfMonth,
        nextExpectedDate: cadence.nextExpectedDate,
      };
      if (!stream.cadence) continue; // no recognizable pattern

      const { classification, confidence } = classify(stream, merchant, input.priorFeedback);
      stream = { ...stream, classification, confidence };
    }

    // User said "not a subscription": suppress, keep as negative signal.
    const negative = input.priorFeedback.some(
      (f) => !f.userConfirmed && f.normalizedMerchant === stream.normalizedMerchant,
    );
    if (negative) {
      streams.push({ ...stream, suppressed: true, verdict: null });
      continue;
    }

    // Price steps only mean something for subscriptions — variable bills and
    // habit spending jitter constantly.
    const priceChange =
      stream.dates.length >= 3 && stream.classification === "subscription"
        ? detectPriceChange(stream)
        : null;
    if (priceChange) {
      priceChanges.push(priceChange);
    }

    stream = {
      ...stream,
      verdict: verdictFor(stream, merchant, input.priorFeedback, priceChange, input.today),
    };
    streams.push(stream);

    // Event candidates (the orchestrator diffs against persisted state).
    if (priceChange && Number(priceChange.newAmount) > Number(priceChange.oldAmount)) {
      events.push({
        type: "price_increased",
        streamKey: stream.key,
        oldAmount: priceChange.oldAmount,
        newAmount: priceChange.newAmount,
        effectiveDate: priceChange.effectiveDate,
      });
    }
    if (stream.classification === "subscription") {
      events.push({ type: "new_probable_subscription", streamKey: stream.key });
      if (stream.nextExpectedDate) {
        const untilNext = daysBetween(input.today, stream.nextExpectedDate);
        if (untilNext < -MISSED_GRACE_DAYS) {
          events.push({
            type: "expected_charge_missed",
            streamKey: stream.key,
            expectedDate: stream.nextExpectedDate,
          });
        }
        if (
          (stream.cadence === "annual" || stream.cadence === "quarterly") &&
          untilNext >= 0 &&
          untilNext <= RENEWAL_WINDOW_DAYS
        ) {
          events.push({
            type: "renewal_upcoming",
            streamKey: stream.key,
            expectedDate: stream.nextExpectedDate,
          });
        }
      }
    }
  }

  streams.sort((a, b) => a.key.localeCompare(b.key));
  priceChanges.sort((a, b) => a.streamKey.localeCompare(b.streamKey));
  events.sort((a, b) =>
    a.streamKey === b.streamKey
      ? a.type.localeCompare(b.type)
      : a.streamKey.localeCompare(b.streamKey),
  );
  return { streams, priceChanges, events };
}

function verdictFor(
  stream: Stream,
  merchant: { category: string | null } | null,
  priorFeedback: EngineInput["priorFeedback"],
  priceChange: PriceChange | null,
  today: string,
): Stream["verdict"] {
  if (stream.verdict === "probable_annual") return "probable_annual";
  if (stream.classification !== "subscription") return null; // bills/habits carry no verdict

  // Invariant 5: below 0.80 we ask, we never assert.
  if (stream.confidence < 0.8) return "question";

  if (priceChange && Number(priceChange.newAmount) > Number(priceChange.oldAmount)) {
    return "price_increased";
  }

  // "Likely forgotten" needs more than age: a forgettable category, a year of
  // charges, and no explicit user confirmation. Long unbroken patterns are
  // otherwise exactly what healthy looks like.
  const confirmed = priorFeedback.some(
    (f) => f.userConfirmed && f.normalizedMerchant === stream.normalizedMerchant,
  );
  if (
    !confirmed &&
    merchant?.category &&
    FORGETTABLE_CATEGORIES.has(merchant.category) &&
    daysBetween(stream.firstChargeDate, today) >= FORGOTTEN_TENURE_DAYS
  ) {
    return "likely_forgotten";
  }
  return "healthy";
}
