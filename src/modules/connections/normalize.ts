/**
 * Write-time normalization and flagging for ingested transactions.
 * Pure functions — unit tested, no I/O.
 *
 * The noise-strip is the detection engine's canonical one (engine/ is pure,
 * so this import direction is safe) — ingestion and detection always agree.
 * Alias matching against the merchant table happens at detection time.
 */
import { stripDescriptorNoise } from "@/modules/detection/engine/normalize";

export function normalizeMerchantBasic(rawDescriptor: string): string {
  return stripDescriptorNoise(rawDescriptor);
}

export type FlagInput = {
  amount: number;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  legacyCategories: string[];
};

/**
 * Transfers and card payments must never count toward spend aggregations.
 * Plaid convention: positive amount = money out, negative = money in.
 */
export function isTransfer(input: FlagInput): boolean {
  const primary = input.pfcPrimary?.toUpperCase() ?? "";
  const detailed = input.pfcDetailed?.toUpperCase() ?? "";
  if (primary === "TRANSFER_IN" || primary === "TRANSFER_OUT") return true;
  if (detailed.includes("CREDIT_CARD_PAYMENT")) return true;
  const legacy = input.legacyCategories.map((c) => c.toLowerCase());
  return legacy.some(
    (c) => c === "transfer" || c === "payment" || c === "credit card" || c === "credit",
  );
}

/**
 * Refund heuristic: money in (negative amount) from a merchant the account was
 * recently charged by. `hadRecentCharge` is resolved by the caller (a DB
 * lookup in the sync job), keeping this function pure.
 */
export function isRefund(input: FlagInput, hadRecentCharge: boolean): boolean {
  if (input.amount >= 0) return false;
  if (isTransfer(input)) return false;
  return hadRecentCharge;
}

/** Rows that count toward any amount aggregation, ever. */
export function isCountable(row: {
  isTransfer: boolean;
  isRefund: boolean;
  pending: boolean;
}): boolean {
  return !row.isTransfer && !row.isRefund && !row.pending;
}
