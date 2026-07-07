import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  accounts,
  alerts,
  connections,
  merchants,
  priceChanges,
  subscriptions,
  transactions,
} from "@/db/schema";
import { runEngine } from "./engine";
import type {
  EngineEvent,
  EngineMerchant,
  EngineTransaction,
  PriorFeedback,
  Stream,
} from "./engine/types";

/**
 * The detection job: load the user's world, run the pure engine, diff the
 * output against persisted state, and write only what changed. Re-running on
 * unchanged input writes nothing (invariant 4 — the idempotency test enforces
 * this literally).
 */
export async function runDetection(
  userId: string,
  opts: { accountIds?: string[] } = {},
): Promise<{ streams: number; created: number; updated: number; events: number }> {
  // ---- Load ---------------------------------------------------------------
  const accountRows = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .where(eq(connections.userId, userId));
  let accountIds = accountRows.map((a) => a.id);
  if (opts.accountIds?.length) {
    const requested = new Set(opts.accountIds);
    accountIds = accountIds.filter((id) => requested.has(id));
  }
  if (accountIds.length === 0) return { streams: 0, created: 0, updated: 0, events: 0 };

  const txnRows = await db
    .select()
    .from(transactions)
    .where(inArray(transactions.accountId, accountIds));

  const merchantRows = await db.select().from(merchants);
  const engineMerchants: EngineMerchant[] = merchantRows.map((m) => ({
    id: m.id,
    name: m.name,
    aliases: (m.aliases as string[]) ?? [],
    category: m.category,
    knownPlans: (m.knownPlans as EngineMerchant["knownPlans"]) ?? [],
  }));

  const feedbackRows = await db
    .select({
      normalizedMerchant: subscriptions.normalizedMerchant,
      userConfirmed: subscriptions.userConfirmed,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNotNull(subscriptions.userConfirmed)));
  const priorFeedback: PriorFeedback[] = feedbackRows.map((f) => ({
    normalizedMerchant: f.normalizedMerchant,
    userConfirmed: f.userConfirmed!,
  }));

  const engineTransactions: EngineTransaction[] = txnRows.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amount: t.amount,
    currency: t.currency,
    rawDescriptor: t.rawDescriptor,
    pending: t.pending,
    isTransfer: t.isTransfer,
    isRefund: t.isRefund,
  }));

  // ---- Run the pure engine --------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const output = runEngine({
    transactions: engineTransactions,
    merchants: engineMerchants,
    priorFeedback,
    today,
  });

  // ---- Diff + persist -------------------------------------------------------
  const existing = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const existingByKey = new Map(existing.map((s) => [s.streamKey, s]));

  let created = 0;
  let updated = 0;
  let eventsPersisted = 0;

  await db.transaction(async (tx) => {
    const idByStreamKey = new Map<string, string>();

    for (const stream of output.streams) {
      const row = existingByKey.get(stream.key);

      if (!row) {
        if (stream.suppressed) continue; // never resurrect a rejected merchant
        const [inserted] = await tx
          .insert(subscriptions)
          .values(streamToRow(userId, stream))
          .returning({ id: subscriptions.id });
        idByStreamKey.set(stream.key, inserted!.id);
        created++;
        continue;
      }

      idByStreamKey.set(stream.key, row.id);
      // Respect user state: dismissed/cancelled rows keep their status, and
      // user_confirmed is never engine-written.
      const next = streamToRow(userId, stream);
      if (row.status === "dismissed" || row.status === "cancelled") {
        next.status = row.status;
      }
      if (rowChanged(row, next)) {
        await tx
          .update(subscriptions)
          .set({ ...next, updatedAt: new Date() })
          .where(eq(subscriptions.id, row.id));
        updated++;
      }
    }

    // Link evidence transactions to their stream (only rows whose link changed).
    for (const stream of output.streams) {
      const subscriptionId = idByStreamKey.get(stream.key);
      if (!subscriptionId || stream.suppressed) continue;
      await tx
        .update(transactions)
        .set({ subscriptionId })
        .where(
          and(
            inArray(transactions.id, stream.transactionIds),
            sql`${transactions.subscriptionId} is distinct from ${subscriptionId}`,
          ),
        );
    }

    // Price changes: insert only when this exact step isn't recorded yet.
    for (const pc of output.priceChanges) {
      const subscriptionId = idByStreamKey.get(pc.streamKey);
      if (!subscriptionId) continue;
      const [dupe] = await tx
        .select({ id: priceChanges.id })
        .from(priceChanges)
        .where(
          and(
            eq(priceChanges.subscriptionId, subscriptionId),
            eq(priceChanges.oldAmount, pc.oldAmount),
            eq(priceChanges.newAmount, pc.newAmount),
            eq(priceChanges.effectiveDate, pc.effectiveDate),
          ),
        );
      if (!dupe) {
        await tx.insert(priceChanges).values({
          subscriptionId,
          oldAmount: pc.oldAmount,
          newAmount: pc.newAmount,
          effectiveDate: pc.effectiveDate,
        });
      }
    }

    // Persist alertable events unsent (Stage 7 dispatches). The unique
    // (subscription_id, type, dedup_key) gate makes this idempotent.
    for (const event of output.events) {
      const persisted = await persistEvent(tx, userId, event, idByStreamKey);
      if (persisted) eventsPersisted++;
    }

    // First detection done: connections graduate from ok to ready.
    await tx
      .update(connections)
      .set({ status: "ready", updatedAt: new Date() })
      .where(and(eq(connections.userId, userId), eq(connections.status, "ok")));
  });

  return { streams: output.streams.length, created, updated, events: eventsPersisted };
}

type SubscriptionRow = typeof subscriptions.$inferInsert;

function streamToRow(userId: string, stream: Stream): SubscriptionRow {
  return {
    userId,
    streamKey: stream.key,
    accountId: stream.accountId,
    merchantId: stream.merchantId,
    normalizedMerchant: stream.normalizedMerchant,
    cadence: stream.cadence,
    classification: stream.classification,
    verdict: stream.verdict,
    confidence: stream.confidence.toFixed(2),
    status: stream.suppressed ? "dismissed" : "active",
    currentAmount: stream.currentAmount,
    currency: stream.currency,
    nextExpectedDate: stream.nextExpectedDate,
    firstChargeDate: stream.firstChargeDate,
    lastChargeDate: stream.lastChargeDate,
  };
}

/** Field-level diff so unchanged reruns issue zero UPDATEs. */
function rowChanged(row: typeof subscriptions.$inferSelect, next: SubscriptionRow): boolean {
  return (
    row.merchantId !== (next.merchantId ?? null) ||
    row.normalizedMerchant !== next.normalizedMerchant ||
    row.cadence !== (next.cadence ?? null) ||
    row.classification !== (next.classification ?? null) ||
    row.verdict !== (next.verdict ?? null) ||
    row.confidence !== next.confidence ||
    row.status !== next.status ||
    row.currentAmount !== next.currentAmount ||
    row.currency !== next.currency ||
    row.nextExpectedDate !== (next.nextExpectedDate ?? null) ||
    row.firstChargeDate !== (next.firstChargeDate ?? null) ||
    row.lastChargeDate !== (next.lastChargeDate ?? null)
  );
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Map engine events to alert rows (unsent — Stage 7 adds dispatch). Only
 * price_increased and renewal_upcoming are alert types; the other events are
 * engine outputs consumed elsewhere. Dedup keys follow Stage 7's conventions.
 */
async function persistEvent(
  tx: Tx,
  userId: string,
  event: EngineEvent,
  idByStreamKey: Map<string, string>,
): Promise<boolean> {
  const subscriptionId = idByStreamKey.get(event.streamKey);
  if (!subscriptionId) return false;

  let type: "price_increase" | "renewal_upcoming";
  let dedupKey: string;
  let payload: Record<string, unknown>;

  if (event.type === "price_increased") {
    type = "price_increase";
    dedupKey = `${event.oldAmount}->${event.newAmount}`;
    payload = {
      old_amount: event.oldAmount,
      new_amount: event.newAmount,
      effective_date: event.effectiveDate,
    };
  } else if (event.type === "renewal_upcoming") {
    type = "renewal_upcoming";
    dedupKey = event.expectedDate;
    payload = { expected_date: event.expectedDate };
  } else {
    return false;
  }

  const inserted = await tx
    .insert(alerts)
    .values({ userId, subscriptionId, type, dedupKey, payload })
    .onConflictDoNothing({
      target: [alerts.subscriptionId, alerts.type, alerts.dedupKey],
    })
    .returning({ id: alerts.id });
  return inserted.length > 0;
}
