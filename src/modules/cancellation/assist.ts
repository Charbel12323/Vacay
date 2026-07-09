import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { assistOpens, merchants, priceChanges, subscriptions, users } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { cancellationInfoSchema, GENERIC_GUIDANCE, type CancellationInfo } from "./schema";
import { cadenceLabel, renderTemplate, type DraftMessage } from "./templates";

/**
 * Cancellation assist (Stage 8): resolve a subscription to verified
 * instructions + a drafted message, or the honest generic fallback. Tiers
 * 1-2 only — instructions and drafts. There is NO automation against
 * merchant sites anywhere in this module, by product decision.
 */

export type AssistPayload = {
  merchant: string;
  had_data: boolean;
  method: CancellationInfo["method"] | "unknown";
  url?: string;
  email?: string;
  phone?: string;
  steps: string[];
  difficulty: number;
  notes?: string;
  draft: DraftMessage | null;
};

export async function buildAssistPayload(
  subscriptionId: string,
  userId: string,
): Promise<AssistPayload | null> {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
  if (!sub || sub.userId !== userId) return null;

  // Resolve the merchant row: by id when detection matched one, otherwise by
  // case-insensitive name (normalized merchants are lowercase).
  const [merchant] = sub.merchantId
    ? await db.select().from(merchants).where(eq(merchants.id, sub.merchantId))
    : await db
        .select()
        .from(merchants)
        .where(sql`lower(${merchants.name}) = ${sub.normalizedMerchant}`);

  const parsed = merchant?.cancellationInfo
    ? cancellationInfoSchema.safeParse(merchant.cancellationInfo)
    : null;
  const info = parsed?.success ? parsed.data : null;
  const displayName = merchant?.name ?? titleCase(sub.normalizedMerchant);

  // Demand telemetry: merchant-level counts only, NEVER a user reference.
  await db.insert(assistOpens).values({
    merchant: sub.normalizedMerchant,
    hadData: Boolean(info),
  });

  const draft = await buildDraft(sub, displayName, info);

  if (!info) {
    return {
      merchant: displayName,
      had_data: false,
      ...GENERIC_GUIDANCE,
      draft,
    };
  }

  return {
    merchant: displayName,
    had_data: true,
    method: info.method,
    url: info.url,
    email: info.email,
    phone: info.phone,
    steps: info.steps,
    difficulty: info.difficulty,
    notes: info.notes,
    draft,
  };
}

type SubscriptionRow = typeof subscriptions.$inferSelect;

/**
 * Draft selection: after a price increase a price-match message is the
 * stronger move; otherwise a cancellation message — but only where a written
 * message is actually usable (email/chat/phone-with-template merchants).
 */
async function buildDraft(
  sub: SubscriptionRow,
  displayName: string,
  info: CancellationInfo | null,
): Promise<DraftMessage | null> {
  const messageUsable =
    info !== null &&
    (info.method === "email" || info.method === "chat" || Boolean(info.template_id));
  if (!messageUsable) return null;

  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, sub.userId));
  const common = {
    merchant: displayName,
    amount: formatMoney(sub.currentAmount, sub.currency),
    cadence_label: cadenceLabel(sub.cadence),
    // The user edits before copying; an obvious placeholder beats a wrong name.
    first_name: user?.name?.trim().split(/\s+/)[0] ?? "(your name)",
  };

  if (sub.verdict === "price_increased" || info.template_id === "price_match") {
    const [change] = await db
      .select()
      .from(priceChanges)
      .where(eq(priceChanges.subscriptionId, sub.id))
      .orderBy(desc(priceChanges.effectiveDate))
      .limit(1);
    if (change) {
      return renderTemplate("price_match", {
        ...common,
        old_price: formatMoney(change.oldAmount, sub.currency),
        new_price: formatMoney(change.newAmount, sub.currency),
      });
    }
  }
  return renderTemplate("cancellation", common);
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
