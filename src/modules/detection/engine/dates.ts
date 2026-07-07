/** Small pure date helpers over YYYY-MM-DD strings (UTC, no Date.now). */

export function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOfMonth(date: string): number {
  return toUtc(date).getUTCDate();
}

/** Same day next month, clamped to the target month's length. */
export function addMonthsClamped(date: string, months: number, targetDay?: number): string {
  const d = toUtc(date);
  const day = targetDay ?? d.getUTCDate();
  const result = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const daysInMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInMonth));
  return result.toISOString().slice(0, 10);
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Coefficient of variation (stddev / mean); 0 for constant series. */
export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(m);
}
