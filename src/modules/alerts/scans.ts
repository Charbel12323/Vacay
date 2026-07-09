import { and, eq, gte, inArray, lte, lt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, connections, subscriptions, transactions } from "@/db/schema";
import { enqueueAlertDispatch, enqueueDetection } from "@/lib/queues";
import { createAlert, insertAlert, reauthDedupKey } from "./create";

/**
 * Daily scheduled scans (Stage 7 task 5). All alert writes go through the
 * dedup gate, so running any scan twice — or every day over the same data —
 * creates nothing new. Renewal/upcoming alerts key on the expected date;
 * staleness alerts key on connection + ISO week.
 */

const RENEWAL_WINDOW_DAYS = 30;
const UPCOMING_WINDOW_DAYS = 3;
const STALE_AFTER_DAYS = 3;

/** Cadences whose renewals are worth a 30-day heads-up. */
const RENEWAL_CADENCES = ["annual", "quarterly"] as const;

export type ScanDeps = {
  enqueueDetectionFn?: typeof enqueueDetection;
};

export type ScanResult = {
  renewals: number;
  upcoming: number;
  stale: number;
  reconciled: number;
};

export async function runDailyScans(now = new Date(), deps: ScanDeps = {}): Promise<ScanResult> {
  const renewals = await renewalScan(now);
  const upcoming = await upcomingChargeScan(now);
  const stale = await stalenessScan(now);
  const reconciled = await reconciliationSweep(deps.enqueueDetectionFn ?? enqueueDetection);
  return { renewals, upcoming, stale, reconciled };
}

/** Annual/quarterly subscriptions renewing within 30 days → renewal alert. */
export async function renewalScan(now: Date): Promise<number> {
  const rows = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      nextExpectedDate: subscriptions.nextExpectedDate,
      cadence: subscriptions.cadence,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        eq(subscriptions.classification, "subscription"),
        inArray(subscriptions.cadence, [...RENEWAL_CADENCES]),
        gte(subscriptions.nextExpectedDate, isoDate(now)),
        lte(subscriptions.nextExpectedDate, isoDate(addDays(now, RENEWAL_WINDOW_DAYS))),
      ),
    );

  let created = 0;
  for (const sub of rows) {
    const id = await createAlert({
      userId: sub.userId,
      subscriptionId: sub.id,
      type: "renewal_upcoming",
      dedupKey: sub.nextExpectedDate!,
      payload: { expected_date: sub.nextExpectedDate, cadence: sub.cadence },
    });
    if (id) created++;
  }
  return created;
}

/**
 * Any subscription charging within 3 days → upcoming-charge alert. Created
 * in-app for every cadence (the feed is cheap); whether it becomes an EMAIL
 * is the dispatcher's preference check — default OFF for monthly, ON for
 * annual/quarterly (too-noisy rule, stage doc task 5).
 */
export async function upcomingChargeScan(now: Date): Promise<number> {
  const rows = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      nextExpectedDate: subscriptions.nextExpectedDate,
      cadence: subscriptions.cadence,
      amount: subscriptions.currentAmount,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        eq(subscriptions.classification, "subscription"),
        gte(subscriptions.nextExpectedDate, isoDate(now)),
        lte(subscriptions.nextExpectedDate, isoDate(addDays(now, UPCOMING_WINDOW_DAYS))),
      ),
    );

  let created = 0;
  for (const sub of rows) {
    const id = await createAlert({
      userId: sub.userId,
      subscriptionId: sub.id,
      type: "upcoming_charge",
      dedupKey: sub.nextExpectedDate!,
      payload: {
        expected_date: sub.nextExpectedDate,
        cadence: sub.cadence,
        amount: sub.amount,
      },
    });
    if (id) created++;
  }
  return created;
}

/**
 * Healthy-looking connections that quietly stopped syncing (no successful
 * sync in 3 days) → degraded + a reauth-style alert. Status flips and alert
 * insert commit together; dispatch is enqueued only after (invariant 2).
 */
export async function stalenessScan(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000);
  const stale = await db
    .select({
      id: connections.id,
      userId: connections.userId,
      institutionName: connections.institutionName,
    })
    .from(connections)
    .where(
      and(
        inArray(connections.status, ["ok", "ready"]),
        or(
          lt(connections.lastSyncedAt, cutoff),
          and(isNull(connections.lastSyncedAt), lt(connections.createdAt, cutoff)),
        ),
      ),
    );

  const insertedIds: string[] = [];
  for (const conn of stale) {
    await db.transaction(async (tx) => {
      await tx
        .update(connections)
        .set({ status: "degraded", updatedAt: new Date() })
        .where(eq(connections.id, conn.id));
      const id = await insertAlert(tx, {
        userId: conn.userId,
        connectionId: conn.id,
        type: "reauth_required",
        dedupKey: reauthDedupKey(conn.id, now),
        payload: { institution_name: conn.institutionName, reason: "stale_sync" },
      });
      if (id) insertedIds.push(id);
    });
  }
  for (const id of insertedIds) await enqueueAlertDispatch(id);
  return insertedIds.length;
}

/**
 * The reconciliation sweep (safety net for lost events): any connection whose
 * newest ingested transaction postdates its last detection run gets a
 * detection re-enqueued. Detection is idempotent, so a false positive costs a
 * no-op run, while a miss here means a user staring at stale verdicts.
 */
export async function reconciliationSweep(
  enqueue: typeof enqueueDetection = enqueueDetection,
): Promise<number> {
  const behind = await db
    .select({ userId: connections.userId })
    .from(connections)
    .innerJoin(accounts, eq(accounts.connectionId, connections.id))
    .innerJoin(transactions, eq(transactions.accountId, accounts.id))
    .groupBy(connections.id, connections.userId)
    .having(
      sql`max(${transactions.createdAt}) > coalesce(${connections.lastDetectionAt}, 'epoch'::timestamptz)`,
    );

  const userIds = [...new Set(behind.map((b) => b.userId))];
  for (const userId of userIds) await enqueue(userId);
  return userIds.length;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
