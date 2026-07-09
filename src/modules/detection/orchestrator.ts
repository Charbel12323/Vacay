import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  accounts,
  connections,
  merchants,
  priceChanges,
  subscriptions,
  transactions,
} from "@/db/schema";
import { enqueueAlertDispatch } from "@/lib/queues";
import { insertAlert } from "@/modules/alerts/create";
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
  const insertedAlertIds: string[] = [];

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

      // Stage 8 outcome tracking: a charge landing AFTER the user cancelled
      // is alert-worthy. Through the dedup gate (date:amount), so re-running
      // detection over the same charge never re-alerts.
      if (
        row.status === "cancelled" &&
        row.cancelledAt &&
        stream.lastChargeDate &&
        stream.lastChargeDate > row.cancelledAt.toISOString().slice(0, 10)
      ) {
        const alertId = await insertAlert(tx, {
          userId,
          subscriptionId: row.id,
          type: "charged_after_cancellation",
          dedupKey: `${stream.lastChargeDate}:${stream.currentAmount}`,
          payload: { charge_date: stream.lastChargeDate, amount: stream.currentAmount },
        });
        if (alertId) insertedAlertIds.push(alertId);
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

    // Persist alertable events through the dedup gate (invariant 4). Dispatch
    // is enqueued after this transaction commits, never inside it.
    for (const event of output.events) {
      const alertId = await persistEvent(tx, userId, event, idByStreamKey);
      if (alertId) {
        insertedAlertIds.push(alertId);
        eventsPersisted++;
      }
    }

    // First detection done: connections graduate from ok to ready.
    await tx
      .update(connections)
      .set({ status: "ready", updatedAt: new Date() })
      .where(and(eq(connections.userId, userId), eq(connections.status, "ok")));

    // Stamp the run so the daily reconciliation sweep can spot connections
    // whose transactions are newer than their last detection.
    await tx
      .update(connections)
      .set({ lastDetectionAt: new Date() })
      .where(eq(connections.userId, userId));
  });

  // Truth before announce (invariant 2): the alert rows are durably committed
  // above; only now may email dispatch be enqueued.
  for (const alertId of insertedAlertIds) {
    await enqueueAlertDispatch(alertId);
  }

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
 * Map engine events to alert rows via the Stage 7 creation gate. Only
 * price_increased and renewal_upcoming are alert types; the other events are
 * engine outputs consumed elsewhere. Returns the new alert id, or null when
 * the event maps to nothing or was already alerted.
 */
async function persistEvent(
  tx: Tx,
  userId: string,
  event: EngineEvent,
  idByStreamKey: Map<string, string>,
): Promise<string | null> {
  const subscriptionId = idByStreamKey.get(event.streamKey);
  if (!subscriptionId) return null;

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
    return null;
  }

  return insertAlert(tx, { userId, subscriptionId, type, dedupKey, payload });
}
