import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { alertPreferences } from "@/db/schema";
import type { AlertType } from "./create";

/**
 * Per-type email preferences. Rows in alert_preferences are explicit user
 * overrides; absence means the defaults below apply. reauth_required is
 * transactional — always emailed, never overridable (stage 7 task 7).
 */

/** Email defaults when the user has not chosen. upcoming_charge is special:
 * its default depends on the subscription's cadence (see emailEnabledFor). */
export const EMAIL_DEFAULTS: Record<AlertType, boolean> = {
  price_increase: true,
  renewal_upcoming: true,
  upcoming_charge: false,
  reauth_required: true,
  charged_after_cancellation: true,
};

/** Types the user may toggle. reauth_required is deliberately absent. */
export const CONFIGURABLE_TYPES: AlertType[] = [
  "price_increase",
  "renewal_upcoming",
  "upcoming_charge",
  "charged_after_cancellation",
];

const LOW_NOISE_CADENCES = new Set(["annual", "quarterly"]);

/**
 * Should this alert be emailed? Explicit preference wins; otherwise the
 * default — which for upcoming_charge is ON only for rare cadences (annual,
 * quarterly) because monthly reminders are too noisy to be a default.
 */
export async function emailEnabledFor(
  userId: string,
  type: AlertType,
  opts: { cadence?: string | null } = {},
): Promise<boolean> {
  if (type === "reauth_required") return true;

  const [row] = await db
    .select({ emailEnabled: alertPreferences.emailEnabled })
    .from(alertPreferences)
    .where(and(eq(alertPreferences.userId, userId), eq(alertPreferences.type, type)));
  if (row) return row.emailEnabled;

  if (type === "upcoming_charge") {
    return opts.cadence != null && LOW_NOISE_CADENCES.has(opts.cadence);
  }
  return EMAIL_DEFAULTS[type];
}

export type EffectivePreference = {
  type: AlertType;
  email_enabled: boolean;
  is_default: boolean;
};

/** The settings view: every configurable type with its effective value. */
export async function getEffectivePreferences(userId: string): Promise<EffectivePreference[]> {
  const rows = await db
    .select({ type: alertPreferences.type, emailEnabled: alertPreferences.emailEnabled })
    .from(alertPreferences)
    .where(eq(alertPreferences.userId, userId));
  const byType = new Map(rows.map((r) => [r.type, r.emailEnabled]));

  return CONFIGURABLE_TYPES.map((type) => ({
    type,
    email_enabled: byType.get(type) ?? EMAIL_DEFAULTS[type],
    is_default: !byType.has(type),
  }));
}

/** Upsert one explicit preference. reauth_required is rejected upstream. */
export async function setPreference(
  userId: string,
  type: AlertType,
  emailEnabled: boolean,
): Promise<void> {
  await db
    .insert(alertPreferences)
    .values({ userId, type, emailEnabled })
    .onConflictDoUpdate({
      target: [alertPreferences.userId, alertPreferences.type],
      set: { emailEnabled, updatedAt: new Date() },
    });
}
