import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userStatusEnum = pgEnum("user_status", ["active", "deleted_pending"]);

// Lifecycle: pending -> syncing -> ready (after first detection). Steady state
// is ok; reauth_required / degraded are health problems; revoking precedes delete.
export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "syncing",
  "ready",
  "ok",
  "reauth_required",
  "degraded",
  "revoking",
]);

export const cadenceEnum = pgEnum("cadence", [
  "weekly",
  "biweekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "annual",
]);

export const classificationEnum = pgEnum("classification", ["subscription", "bill", "habit"]);

// "question" is the sub-0.80-confidence bucket: surfaced to the user as a
// question, never asserted as a verdict (plan.md invariant 5).
export const verdictEnum = pgEnum("verdict", [
  "healthy",
  "price_increased",
  "likely_forgotten",
  "probable_annual",
  "question",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "dismissed",
  "cancelled",
]);

export const alertTypeEnum = pgEnum("alert_type", [
  "price_increase",
  "renewal_upcoming",
  "upcoming_charge",
  "reauth_required",
  "charged_after_cancellation",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // bcrypt hash; NULL for OAuth-only users.
  passwordHash: text("password_hash"),
  authProviderId: text("auth_provider_id"),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plaidItemId: text("plaid_item_id").notNull().unique(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    // AES-256-GCM envelope: iv:tag:ciphertext (base64 segments). Never the raw token.
    accessTokenEnc: text("access_token_enc").notNull(),
    // Plaid /transactions/sync cursor. Only ever updated in the SAME db
    // transaction as the page of rows it corresponds to (plan.md invariant 1).
    cursor: text("cursor"),
    status: connectionStatusEnum("status").notNull().default("pending"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // When detection last ran over this connection's transactions. The daily
    // reconciliation sweep compares this to the newest ingested transaction
    // to catch lost detection events (Stage 7).
    lastDetectionAt: timestamp("last_detection_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("connections_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    plaidAccountId: text("plaid_account_id").notNull().unique(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    mask: text("mask"),
    currency: text("currency").notNull().default("CAD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("accounts_connection_id_idx").on(table.connectionId)],
);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  aliases: jsonb("aliases").notNull().default([]),
  category: text("category"),
  knownPlans: jsonb("known_plans").notNull().default([]),
  cancellationInfo: jsonb("cancellation_info"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Engine stream identity (accountId:merchant:cluster) — the diff key for
    // idempotent detection upserts.
    streamKey: text("stream_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    normalizedMerchant: text("normalized_merchant").notNull(),
    cadence: cadenceEnum("cadence"),
    classification: classificationEnum("classification"),
    verdict: verdictEnum("verdict"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    currentAmount: numeric("current_amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("CAD"),
    nextExpectedDate: date("next_expected_date"),
    firstChargeDate: date("first_charge_date"),
    lastChargeDate: date("last_charge_date"),
    userConfirmed: boolean("user_confirmed"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("subscriptions_user_id_idx").on(table.userId),
    unique("subscriptions_user_stream_key_uq").on(table.userId, table.streamKey),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    plaidTransactionId: text("plaid_transaction_id").notNull().unique(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("CAD"),
    rawDescriptor: text("raw_descriptor").notNull(),
    normalizedMerchant: text("normalized_merchant"),
    pending: boolean("pending").notNull().default(false),
    isTransfer: boolean("is_transfer").notNull().default(false),
    isRefund: boolean("is_refund").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("transactions_account_id_date_idx").on(table.accountId, table.date),
    index("transactions_subscription_id_idx").on(table.subscriptionId),
  ],
);

export const priceChanges = pgTable(
  "price_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    oldAmount: numeric("old_amount", { precision: 12, scale: 2 }).notNull(),
    newAmount: numeric("new_amount", { precision: 12, scale: 2 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("price_changes_subscription_id_idx").on(table.subscriptionId)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable: connection-level alerts (reauth_required) have no subscription.
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "cascade",
    }),
    type: alertTypeEnum("type").notNull(),
    dedupKey: text("dedup_key").notNull(),
    payload: jsonb("payload"),
    read: boolean("read").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sendFailed: boolean("send_failed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The alert idempotency gate (plan.md invariant 4). NULLS NOT DISTINCT so
    // connection-level alerts (NULL subscription_id) dedupe too.
    unique("alerts_subscription_type_dedup_uq")
      .on(table.subscriptionId, table.type, table.dedupKey)
      .nullsNotDistinct(),
    index("alerts_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * Per-type email preferences (Stage 7). Rows are explicit user overrides;
 * absence means the code default applies (price increase and renewal ON,
 * upcoming charge ON for annual/quarterly cadences but OFF for monthly).
 * reauth_required is transactional and has no row — it cannot be disabled.
 */
export const alertPreferences = pgTable(
  "alert_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: alertTypeEnum("type").notNull(),
    emailEnabled: boolean("email_enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("alert_preferences_user_type_uq").on(table.userId, table.type)],
);
