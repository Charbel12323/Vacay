/**
 * Engine types: plain data in, plain data out. This module (and everything in
 * engine/) is pure — no DB, no Plaid, no Redis, no I/O (ESLint-enforced).
 */

export type Cadence = "weekly" | "biweekly" | "monthly" | "bimonthly" | "quarterly" | "annual";
export type Classification = "subscription" | "bill" | "habit";
export type Verdict =
  "healthy" | "price_increased" | "likely_forgotten" | "probable_annual" | "question";

/** Verdicts that assert "this is a subscription" — require confidence ≥ 0.80. */
export const ASSERTED_VERDICTS: readonly Verdict[] = [
  "healthy",
  "price_increased",
  "likely_forgotten",
];

export type EngineTransaction = {
  id: string;
  accountId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Money as string, always. Positive = charge (money out). */
  amount: string;
  currency: string;
  rawDescriptor: string;
  pending: boolean;
  isTransfer: boolean;
  isRefund: boolean;
};

export type KnownPlan = {
  name?: string;
  amount: string;
  cadence: Cadence;
};

export type EngineMerchant = {
  id: string;
  name: string;
  aliases: string[];
  category: string | null;
  knownPlans: KnownPlan[];
};

/** Persisted user feedback, fed back into classification. */
export type PriorFeedback = {
  normalizedMerchant: string;
  userConfirmed: boolean;
};

export type CadenceResult = {
  cadence: Cadence | null;
  medianGapDays: number | null;
  sameDayOfMonth: boolean;
  nextExpectedDate: string | null;
};

export type Stream = {
  /** Stable identity: accountId:normalizedMerchant:cluster ordinal. */
  key: string;
  accountId: string;
  normalizedMerchant: string;
  merchantId: string | null;
  merchantName: string | null;
  transactionIds: string[];
  /** Chronological, parallel arrays. */
  dates: string[];
  amounts: string[];
  currency: string;
  currentAmount: string;
  cadence: Cadence | null;
  sameDayOfMonth: boolean;
  nextExpectedDate: string | null;
  classification: Classification | null;
  confidence: number;
  verdict: Verdict | null;
  firstChargeDate: string;
  lastChargeDate: string;
  /** True when the user said "not a subscription" for this merchant. */
  suppressed: boolean;
};

export type PriceChange = {
  streamKey: string;
  oldAmount: string;
  newAmount: string;
  effectiveDate: string;
};

export type EngineEvent =
  | {
      type: "price_increased";
      streamKey: string;
      oldAmount: string;
      newAmount: string;
      effectiveDate: string;
    }
  | { type: "new_probable_subscription"; streamKey: string }
  | { type: "expected_charge_missed"; streamKey: string; expectedDate: string }
  | { type: "renewal_upcoming"; streamKey: string; expectedDate: string };

export type EngineInput = {
  transactions: EngineTransaction[];
  merchants: EngineMerchant[];
  priorFeedback: PriorFeedback[];
  /** YYYY-MM-DD — injected so the engine stays deterministic. */
  today: string;
};

export type EngineOutput = {
  streams: Stream[];
  priceChanges: PriceChange[];
  events: EngineEvent[];
};
