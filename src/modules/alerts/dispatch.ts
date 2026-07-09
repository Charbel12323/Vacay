import { eq, isNull, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, alerts, connections, merchants, subscriptions, users } from "@/db/schema";
import { env } from "@/lib/env";
import { renderAlertEmail } from "./emails";
import { emailEnabledFor } from "./preferences";

/**
 * Alert email dispatch (Stage 7 task 2). Work-before-acknowledge (invariant
 * 3): render → send → mark sent_at, and only then does the queue job
 * complete. Redelivery after a crash hits the sent_at guard and skips, so a
 * kill between send and completion never double-sends. The Resend
 * Idempotency-Key (the alert id) additionally covers the tiny window between
 * the send call and the sent_at write.
 */

export type EmailMessage = { to: string; subject: string; html: string };
export type EmailSender = (msg: EmailMessage, idempotencyKey: string) => Promise<void>;

export type DispatchOutcome =
  "sent" | "already_sent" | "email_disabled" | "email_not_configured" | "missing";

export async function dispatchAlert(alertId: string, send?: EmailSender): Promise<DispatchOutcome> {
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId));
  if (!alert) return "missing";

  // The double-send guard: a redelivered job for an already-sent alert is a
  // no-op, not a second email.
  if (alert.sentAt) return "already_sent";

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, alert.userId));
  if (!user) return "missing";

  const context = await loadContext(alert);

  const enabled = await emailEnabledFor(alert.userId, alert.type, {
    cadence: context.cadence,
  });
  if (!enabled) return "email_disabled"; // in-app only, by choice or default

  // Without a real Resend key (local dev) the alert stays in-app-only and
  // sent_at stays NULL — we never fake a send. An injected sender (tests)
  // bypasses this gate; it only guards the real transport.
  const sender = send ?? (emailConfigured() ? resendSender : null);
  if (!sender) return "email_not_configured";

  const { subject, html } = await renderAlertEmail({
    type: alert.type,
    payload: (alert.payload ?? {}) as Record<string, unknown>,
    ...context,
    baseUrl: env().APP_BASE_URL,
  });

  await sender({ to: user.email, subject, html }, alert.id);

  // Mark sent BEFORE the job completes (work before acknowledge). Conditional
  // on sent_at still being NULL so a racing duplicate can't stamp twice.
  await db
    .update(alerts)
    .set({ sentAt: new Date() })
    .where(and(eq(alerts.id, alertId), isNull(alerts.sentAt)));
  return "sent";
}

/** Permanent send failure (queue retries exhausted): in-app-only + flagged. */
export async function markSendFailed(alertId: string): Promise<void> {
  await db
    .update(alerts)
    .set({ sendFailed: true })
    .where(and(eq(alerts.id, alertId), isNull(alerts.sentAt)));
}

type AlertRow = typeof alerts.$inferSelect;

async function loadContext(alert: AlertRow): Promise<{
  merchantName: string | null;
  amount: string | null;
  currency: string;
  cadence: string | null;
  accountMask: string | null;
  institutionName: string | null;
}> {
  let merchantName: string | null = null;
  let amount: string | null = null;
  let currency = "CAD";
  let cadence: string | null = null;
  let accountMask: string | null = null;
  let institutionName: string | null = null;

  if (alert.subscriptionId) {
    const [sub] = await db
      .select({
        normalizedMerchant: subscriptions.normalizedMerchant,
        merchantName: merchants.name,
        amount: subscriptions.currentAmount,
        currency: subscriptions.currency,
        cadence: subscriptions.cadence,
        mask: accounts.mask,
      })
      .from(subscriptions)
      .leftJoin(merchants, eq(subscriptions.merchantId, merchants.id))
      .leftJoin(accounts, eq(subscriptions.accountId, accounts.id))
      .where(eq(subscriptions.id, alert.subscriptionId));
    if (sub) {
      merchantName = sub.merchantName ?? titleCase(sub.normalizedMerchant);
      amount = sub.amount;
      currency = sub.currency;
      cadence = sub.cadence;
      accountMask = sub.mask;
    }
  }

  if (alert.connectionId) {
    const [conn] = await db
      .select({ institutionName: connections.institutionName })
      .from(connections)
      .where(eq(connections.id, alert.connectionId));
    institutionName = conn?.institutionName ?? null;
  }

  return { merchantName, amount, currency, cadence, accountMask, institutionName };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Real keys look like "re_…"; anything else means local/dev placeholder. */
export function emailConfigured(): boolean {
  return env().RESEND_API_KEY.startsWith("re_");
}

/** Resend HTTP API. The idempotency key makes provider-side retries safe. */
const resendSender: EmailSender = async (msg, idempotencyKey) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `alert/${idempotencyKey}`,
    },
    body: JSON.stringify({
      from: env().EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
    }),
  });
  if (!res.ok) {
    // No body in the error: it could echo recipient details into logs.
    throw new Error(`Resend responded ${res.status}`);
  }
};
