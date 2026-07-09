import { formatMoney } from "@/lib/money";

/**
 * Pure presentation copy for the in-app alert feed. Same tone rules as
 * verdict-ui: calm, factual, evidence-first — never accusatory.
 */

export type FeedAlert = {
  id: string;
  type:
    | "price_increase"
    | "renewal_upcoming"
    | "upcoming_charge"
    | "reauth_required"
    | "charged_after_cancellation";
  payload: Record<string, unknown> | null;
  read: boolean;
  merchant: string | null;
  merchantName: string | null;
  institution: string | null;
  created_at: string;
};

export function alertTitle(alert: FeedAlert): string {
  const merchant = displayMerchant(alert);
  const p = alert.payload ?? {};
  switch (alert.type) {
    case "price_increase":
      return `${merchant} went from ${moneyStr(p.old_amount)} to ${moneyStr(p.new_amount)}`;
    case "renewal_upcoming":
      return `${merchant} looks set to renew on ${String(p.expected_date ?? "an upcoming date")}`;
    case "upcoming_charge":
      return p.amount
        ? `${merchant} will charge ${moneyStr(p.amount)} around ${String(p.expected_date)}`
        : `${merchant} will charge around ${String(p.expected_date)}`;
    case "reauth_required":
      return `${alert.institution ?? "One of your banks"} needs a quick reconnection`;
    case "charged_after_cancellation":
      return `${merchant} charged you after cancellation`;
  }
}

export function displayMerchant(alert: FeedAlert): string {
  if (alert.merchantName) return alert.merchantName;
  if (alert.merchant) return titleCase(alert.merchant);
  return "A subscription";
}

function moneyStr(value: unknown): string {
  return typeof value === "string" ? formatMoney(value) : "?";
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
