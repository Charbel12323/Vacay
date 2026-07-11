import { db } from "@/db/client";
import { alerts, alertTypeEnum } from "@/db/schema";
import { enqueueAlertDispatch } from "@/lib/queues";

/**
 * Alert creation — the idempotency gate (plan.md invariant 4).
 *
 * Every alert in the system is born here, through one unique insert on
 * (subscription_id, type, dedup_key). Dedup key conventions (stage doc):
 *   price_increase              → "{old}->{new}"
 *   renewal_upcoming            → the expected renewal date (YYYY-MM-DD)
 *   upcoming_charge             → the expected charge date (YYYY-MM-DD)
 *   reauth_required             → "{connectionId}:{ISO week}", e.g. "…:2026-W28"
 *   charged_after_cancellation  → "{charge date}:{amount}" (Stage 8)
 * New alert types must document their dedup_key in stages/stage7.md first.
 */

export type AlertType = (typeof alertTypeEnum.enumValues)[number];

export type AlertInput = {
  userId: string;
  type: AlertType;
  dedupKey: string;
  subscriptionId?: string | null;
  connectionId?: string | null;
  payload?: Record<string, unknown>;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = Tx | typeof db;

/**
 * The gate itself: insert-or-nothing. Returns the new alert id, or null when
 * this exact alert already exists (already alerted — do nothing). Usable
 * inside a larger transaction; the CALLER must enqueue dispatch after its
 * transaction commits (invariant 2 — truth before announce).
 */
export async function insertAlert(dbOrTx: DbOrTx, input: AlertInput): Promise<string | null> {
  const inserted = await dbOrTx
    .insert(alerts)
    .values({
      userId: input.userId,
      type: input.type,
      dedupKey: input.dedupKey,
      subscriptionId: input.subscriptionId ?? null,
      connectionId: input.connectionId ?? null,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing({
      target: [alerts.subscriptionId, alerts.type, alerts.dedupKey],
    })
    .returning({ id: alerts.id });
  return inserted[0]?.id ?? null;
}

/**
 * Standalone create: commit the row, then enqueue email dispatch — only when
 * the insert actually happened. A dedup conflict means the user was already
 * alerted; no row, no email, return null.
 */
export async function createAlert(input: AlertInput): Promise<string | null> {
  const id = await insertAlert(db, input);
  if (id) await enqueueAlertDispatch(id);
  return id;
}

/** Dedup key for reauth/staleness alerts: connection + ISO week. */
export function reauthDedupKey(connectionId: string, date: Date): string {
  return `${connectionId}:${isoWeek(date)}`;
}

/** ISO-8601 week label, e.g. "2026-W28" (Thursday-anchored, UTC). */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
