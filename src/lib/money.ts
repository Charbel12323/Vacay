/**
 * Money utilities. Amounts are strings everywhere (plan.md §2); all math
 * happens in integer cents — never floats.
 */
import type { Cadence } from "@/modules/detection/engine/types";

export function toCents(amount: string): number {
  const negative = amount.startsWith("-");
  const [whole = "0", frac = ""] = amount.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isFinite(cents)) throw new Error(`Bad amount: ${amount}`);
  return negative ? -cents : cents;
}

export function centsToString(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Charges per year for each cadence. */
const CHARGES_PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  annual: 1,
};

/** Monthly-equivalent cents: amount × charges-per-year ÷ 12, rounded. */
export function monthlyEquivalentCents(amount: string, cadence: Cadence): number {
  return Math.round((toCents(amount) * CHARGES_PER_YEAR[cadence]) / 12);
}

/** Render "12.99" (+ currency) for UI. The single money formatter. */
export function formatMoney(amount: string, currency = "CAD"): string {
  const cents = toCents(amount);
  const symbol = currency === "USD" ? "US$" : "$";
  return `${cents < 0 ? "-" : ""}${symbol}${centsToString(Math.abs(cents))}`;
}
