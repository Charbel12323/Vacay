import type { EngineMerchant } from "./types";

/**
 * Canonical descriptor noise-strip. The write-time normalizer in
 * modules/connections re-exports this so ingestion and detection always agree.
 */
const PROCESSOR_PREFIXES = /^(sq \*|paypal \*|pp\* ?|apl\* ?|tst\* ?|py \*|sp \* ?)/i;

export function stripDescriptorNoise(rawDescriptor: string): string {
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

export type MerchantMatch = {
  normalized: string;
  merchant: EngineMerchant | null;
};

export type AliasIndex = Map<string, EngineMerchant>;

/** Build a lookup of lowercase alias → merchant. Aliases are data, not I/O. */
export function buildAliasIndex(merchants: EngineMerchant[]): AliasIndex {
  const index: AliasIndex = new Map();
  for (const merchant of merchants) {
    index.set(merchant.name.toLowerCase(), merchant);
    for (const alias of merchant.aliases) {
      index.set(alias.toLowerCase(), merchant);
    }
  }
  return index;
}

/**
 * Full normalization: strip noise, then alias-match against the merchant
 * table. A match canonicalizes the merchant string to the merchant's name so
 * "paypal *netflix" and "netflix.com" land in the same stream.
 */
export function normalizeMerchant(rawDescriptor: string, index: AliasIndex): MerchantMatch {
  const stripped = stripDescriptorNoise(rawDescriptor);

  const exact = index.get(stripped);
  if (exact) return { normalized: exact.name.toLowerCase(), merchant: exact };

  // Substring match: an alias appearing inside the descriptor (word-ish
  // boundary) counts. Longest alias wins to avoid "apple" eating "apple tv".
  let best: { merchant: EngineMerchant; alias: string } | null = null;
  for (const [alias, merchant] of index) {
    if (alias.length < 4) continue;
    if (stripped.includes(alias)) {
      if (!best || alias.length > best.alias.length) best = { merchant, alias };
    }
  }
  if (best) return { normalized: best.merchant.name.toLowerCase(), merchant: best.merchant };

  return { normalized: stripped, merchant: null };
}
