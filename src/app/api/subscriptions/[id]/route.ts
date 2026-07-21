import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { invalidateUserDashboards } from "@/lib/cache";
import { accounts, merchants, priceChanges, subscriptions, transactions } from "@/db/schema";
import { enqueueDetection } from "@/lib/queues";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOwned(userId: string, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError("NOT_FOUND", "Not found.");
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)));
  if (!row) throw new ApiError("NOT_FOUND", "Not found.");
  return row;
}

/** Detail + price history + evidence transactions (raw descriptors shown —
 * the exact bank line is deliberate trust-building). */
export const GET = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  const row = await findOwned(user.id, id);

  const [account] = await db
    .select({ name: accounts.name, mask: accounts.mask })
    .from(accounts)
    .where(eq(accounts.id, row.accountId));
  const merchant = row.merchantId
    ? (
        await db
          .select({ name: merchants.name, category: merchants.category })
          .from(merchants)
          .where(eq(merchants.id, row.merchantId))
      )[0]
    : null;

  const history = await db
    .select({
      old_amount: priceChanges.oldAmount,
      new_amount: priceChanges.newAmount,
      effective_date: priceChanges.effectiveDate,
    })
    .from(priceChanges)
    .where(eq(priceChanges.subscriptionId, row.id))
    .orderBy(desc(priceChanges.effectiveDate));

  const evidence = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      currency: transactions.currency,
      raw_descriptor: transactions.rawDescriptor,
      pending: transactions.pending,
    })
    .from(transactions)
    .where(eq(transactions.subscriptionId, row.id))
    .orderBy(desc(transactions.date))
    .limit(50);

  return NextResponse.json({
    subscription: {
      id: row.id,
      merchant: row.normalizedMerchant,
      merchant_name: merchant?.name ?? null,
      category: merchant?.category ?? null,
      cadence: row.cadence,
      classification: row.classification,
      verdict: row.verdict,
      confidence: row.confidence,
      status: row.status,
      current_amount: row.currentAmount,
      currency: row.currency,
      next_expected_date: row.nextExpectedDate,
      first_charge_date: row.firstChargeDate,
      last_charge_date: row.lastChargeDate,
      user_confirmed: row.userConfirmed,
      account: account ? { name: account.name, mask: account.mask } : null,
    },
    price_history: history,
    evidence,
  });
});

// Whitelist body: EXACTLY { user_confirmed: boolean } or
// { status: "dismissed" | "cancelled" } ("cancelled" added by Stage 8's
// mark-as-cancelled action). Anything else is 422.
const patchSchema = z.union([
  z.object({ user_confirmed: z.boolean() }).strict(),
  z.object({ status: z.enum(["dismissed", "cancelled"]) }).strict(),
]);

/**
 * User feedback. CP semantics (invariant 8): synchronous write, respond only
 * after commit; a failure is an error, never fake success.
 */
export const PATCH = withErrorHandling(async (req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  const row = await findOwned(user.id, id);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      'Body must be exactly { user_confirmed: boolean } or { status: "dismissed" | "cancelled" }.',
    );
  }
  const body = parsed.data;

  let enqueueIncremental = false;
  await db.transaction(async (tx) => {
    if ("user_confirmed" in body) {
      if (body.user_confirmed) {
        await tx
          .update(subscriptions)
          .set({ userConfirmed: true, updatedAt: new Date() })
          .where(eq(subscriptions.id, row.id));
      } else {
        // "Not a subscription": persist the negative signal, dismiss, unlink
        // the evidence rows; detection re-runs with this as engine input.
        await tx
          .update(subscriptions)
          .set({
            userConfirmed: false,
            status: "dismissed",
            verdict: null,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, row.id));
        await tx
          .update(transactions)
          .set({ subscriptionId: null })
          .where(eq(transactions.subscriptionId, row.id));
        enqueueIncremental = true;
      }
    } else {
      await tx
        .update(subscriptions)
        .set({
          status: body.status,
          // Outcome tracking (Stage 8): cancelled_at anchors both the savings
          // figure and post-cancellation charge detection.
          cancelledAt: body.status === "cancelled" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, row.id));
    }
  });

  // Invariant 8, read-your-own-writes: the cached dashboard views die
  // BEFORE this response is sent, so the very next read rebuilds fresh.
  await invalidateUserDashboards(user.id);

  // Truth before announce: enqueue only after the commit above.
  if (enqueueIncremental) {
    await enqueueDetection(user.id);
  }

  const [updated] = await db.select().from(subscriptions).where(eq(subscriptions.id, row.id));
  return NextResponse.json({
    subscription: {
      id: updated!.id,
      status: updated!.status,
      user_confirmed: updated!.userConfirmed,
      verdict: updated!.verdict,
    },
  });
});
