/**
 * Write-time normalization and flagging for ingested transactions.
 * Pure functions — unit tested, no I/O.
 *
 * normalizeMerchantBasic is the Stage 5 normalizer's precursor (simple
 * noise-strip only; alias matching arrives with the detection engine).
 */

const PROCESSOR_PREFIXES = /^(sq \*|paypal \*|pp\* ?|apl\* ?|tst\* ?|py \*|sp \* ?)/i;

export function normalizeMerchantBasic(rawDescriptor: string): string {
  let s = rawDescriptor.toLowerCase();
  s = s.replace(PROCESSOR_PREFIXES, "");
  // Phone numbers (800-555-0100, 4165550100, +1 416 555 0100).
  s = s.replace(/\+?1?[\s-.]?\(?\d{3}\)?[\s-.]?\d{3}[\s-.]?\d{4}/g, " ");
  // Store/reference numbers: "#1234", "store 0042", long digit runs.
  s = s.replace(/#\s?\d+/g, " ");
  s = s.replace(/\bstore\s?\d+\b/g, " ");
  s = s.replace(/\b\d{4,}\b/g, " ");
  // Trailing Canadian province / US state codes and common city noise.
  s = s.replace(/\s+(ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt|ca|ny|wa|tx|fl|il)\s*$/i, " ");
  // Punctuation noise, collapse whitespace.
  s = s.replace(/[*_|]/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
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
