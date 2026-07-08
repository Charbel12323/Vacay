import type { PriceChange, Stream } from "./types";

/**
 * Persistent amount step inside a stream: the trailing amount differs from
 * the amount that came before it AND has held for every charge since the
 * step. A one-off odd charge that reverts is not a price change.
 */
export function detectPriceChange(stream: Stream): PriceChange | null {
  const amounts = stream.amounts;
  if (amounts.length < 3) return null;

  const last = amounts[amounts.length - 1]!;
  // Walk back through the run of the new amount.
  let stepIndex = amounts.length - 1;
  while (stepIndex > 0 && amounts[stepIndex - 1] === last) stepIndex--;
  if (stepIndex === 0) return null; // never changed

  const previous = amounts[stepIndex - 1]!;
  if (previous === last) return null;

  // The old amount must itself have been stable (≥2 charges at it, or all
  // prior charges equal) — otherwise this is jitter, not a step.
  const prior = amounts.slice(0, stepIndex);
  const priorAtOld = prior.filter((a) => a === previous).length;
  if (priorAtOld < Math.max(2, Math.ceil(prior.length * 0.6))) return null;

  // Ignore sub-1% / sub-25¢ wobble.
  const delta = Math.abs(Number(last) - Number(previous));
  if (delta < 0.25 || delta / Number(previous) < 0.01) return null;

  return {
    streamKey: stream.key,
    oldAmount: previous,
    newAmount: last,
    effectiveDate: stream.dates[stepIndex]!,
  };
}
