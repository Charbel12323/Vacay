/**
 * Pure presentation logic for subscription verdicts: grouping by severity and
 * calm, factual, evidence-first copy ("we found", never "you wasted").
 *
 * UI-level invariant 5: any stream under 0.80 confidence renders ONLY in the
 * questions group, whatever its verdict field says.
 */
import { formatMoney } from "@/lib/money";

export type SubscriptionListItem = {
  id: string;
  merchant: string;
  merchantName?: string | null;
  cadence: string | null;
  classification: string | null;
  current_amount: string;
  currency: string;
  confidence: string;
  verdict: string | null;
  status: string;
  next_expected_date: string | null;
  first_charge_date: string | null;
  user_confirmed: boolean | null;
  account_mask: string | null;
  account_name?: string | null;
};

export type VerdictGroups = {
  price_increased: SubscriptionListItem[];
  likely_forgotten: SubscriptionListItem[];
  questions: SubscriptionListItem[];
  healthy: SubscriptionListItem[];
};

export function groupByVerdict(items: SubscriptionListItem[]): VerdictGroups {
  const groups: VerdictGroups = {
    price_increased: [],
    likely_forgotten: [],
    questions: [],
    healthy: [],
  };
  for (const item of items) {
    if (item.status !== "active") continue;
    if (item.classification !== "subscription") continue;

    // Below the assertion bar, everything is a question — no exceptions.
    if (Number(item.confidence) < 0.8 || item.verdict === "question") {
      groups.questions.push(item);
      continue;
    }
    if (item.verdict === "probable_annual") {
      groups.questions.push(item);
      continue;
    }
    if (item.verdict === "price_increased") {
      groups.price_increased.push(item);
    } else if (item.verdict === "likely_forgotten") {
      groups.likely_forgotten.push(item);
    } else {
      groups.healthy.push(item);
    }
  }
  return groups;
}

export function displayName(item: SubscriptionListItem): string {
  return item.merchantName ?? titleCase(item.merchant);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthYear(date: string | null): string | null {
  if (!date) return null;
  const [y, m] = date.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export function verdictLine(
  item: SubscriptionListItem,
  priceChange?: { old_amount: string; new_amount: string; effective_date: string } | null,
): string {
  switch (item.verdict) {
    case "price_increased":
      if (priceChange) {
        return `Went from ${formatMoney(priceChange.old_amount, item.currency)} to ${formatMoney(
          priceChange.new_amount,
          item.currency,
        )} in ${monthYear(priceChange.effective_date)}`;
      }
      return "The price went up recently";
    case "likely_forgotten":
      return `Charging since ${monthYear(item.first_charge_date)} — worth a look`;
    case "probable_annual":
      return item.next_expected_date
        ? `Looks like an annual charge — next around ${item.next_expected_date}`
        : "Looks like an annual charge";
    case "healthy":
      return item.first_charge_date
        ? `No charge pattern break since ${monthYear(item.first_charge_date)} — looks healthy`
        : "Looks healthy";
    default:
      return `Is ${displayName(item)} a subscription?`;
  }
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
