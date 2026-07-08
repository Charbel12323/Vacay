import { addDays, addMonthsClamped, dayOfMonth, daysBetween, median } from "./dates";
import type { CadenceResult, Cadence, Stream } from "./types";

/** Median day-gap → cadence bucket (stage doc table). */
const BUCKETS: Array<{ cadence: Cadence; min: number; max: number; months?: number }> = [
  { cadence: "weekly", min: 6, max: 8 },
  { cadence: "biweekly", min: 13, max: 16 },
  { cadence: "monthly", min: 27, max: 33, months: 1 },
  { cadence: "bimonthly", min: 58, max: 64, months: 2 },
  { cadence: "quarterly", min: 85, max: 95, months: 3 },
  { cadence: "annual", min: 350, max: 380, months: 12 },
];

function bucketFor(gap: number): (typeof BUCKETS)[number] | null {
  return BUCKETS.find((b) => gap >= b.min && gap <= b.max) ?? null;
}

/**
 * Detect the charge cadence of a stream.
 *
 * - Needs ≥3 charges (≥2 gaps); a 2-charge stream is only classified when its
 *   single gap lands in the annual band (the "annual with 2 charges" case —
 *   waiting a third year to confirm would be useless).
 * - Tolerates ONE gap ≈2× the median (a missed/failed charge): that gap is
 *   halved for the stats instead of breaking the pattern.
 * - Distinguishes same-date-of-month billing from every-N-days billing via
 *   day-of-month stability — this changes the next-date prediction.
 */
/**
 * Day gaps with the missed-charge correction applied: if exactly one gap is
 * ≈2× the median of the series, halve it (a skipped/failed charge, not a
 * broken pattern). Shared by cadence detection and classification so both
 * see the same rhythm.
 */
export function correctedGaps(dates: string[]): number[] {
  let gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push(daysBetween(dates[i - 1]!, dates[i]!));
  }
  const med0 = median(gaps);
  const doubled = gaps.filter((g) => g >= med0 * 1.75 && g <= med0 * 2.25);
  if (doubled.length === 1) {
    gaps = gaps.map((g) => (g === doubled[0] ? Math.round(g / 2) : g));
  }
  return gaps;
}

export function detectCadence(stream: Stream): CadenceResult {
  const dates = stream.dates;
  const none: CadenceResult = {
    cadence: null,
    medianGapDays: null,
    sameDayOfMonth: false,
    nextExpectedDate: null,
  };

  if (dates.length === 2) {
    const gap = daysBetween(dates[0]!, dates[1]!);
    const bucket = bucketFor(gap);
    if (bucket?.cadence === "annual") {
      return {
        cadence: "annual",
        medianGapDays: gap,
        sameDayOfMonth: dayOfMonth(dates[0]!) === dayOfMonth(dates[1]!),
        nextExpectedDate: addMonthsClamped(dates[1]!, 12),
      };
    }
    return none;
  }
  if (dates.length < 3) return none;

  const gaps = correctedGaps(dates);
  const med = median(gaps);
  const bucket = bucketFor(med);
  if (!bucket) return none;

  // Gaps must be reasonably tight around the bucket (each within the bucket
  // or within 20% of the median) — otherwise it's noise, not a cadence.
  const tight = gaps.every(
    (g) => bucketFor(g)?.cadence === bucket.cadence || Math.abs(g - med) / med <= 0.2,
  );
  if (!tight) return none;

  // Day-of-month stability (monthly and slower): all charge days within a
  // 3-day spread (mod month) means "bills on the Nth". BUT identical gaps
  // across ≥3 intervals is every-N-days billing — calendar months vary in
  // length, so true same-date billing can't produce constant gaps.
  let sameDayOfMonth = false;
  if (bucket.months) {
    const days = dates.map(dayOfMonth);
    const spread = Math.max(...days) - Math.min(...days);
    sameDayOfMonth = spread <= 3 || spread >= 27; // 27+: wraps month end (e.g. 1st vs 30th)
    if (gaps.length >= 3 && gaps.every((g) => g === gaps[0])) {
      sameDayOfMonth = false;
    }
  }

  const last = dates[dates.length - 1]!;
  const nextExpectedDate =
    bucket.months && sameDayOfMonth
      ? addMonthsClamped(last, bucket.months)
      : addDays(last, Math.round(med));

  return { cadence: bucket.cadence, medianGapDays: med, sameDayOfMonth, nextExpectedDate };
}
