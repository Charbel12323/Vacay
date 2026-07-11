import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Stage 9 acceptance (FR15): deleting an account removes Items at Plaid and
 * leaves ZERO rows across all tables for that user. The purge is idempotent
 * and resumable, and pending alert emails become no-ops.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async () => {},
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
  enqueuePurge: async () => {},
}));

async function setupFullWorld() {
  const { db } = await import("@/db/client");
  const {
    accounts,
    alertPreferences,
    alerts,
    connections,
    priceChanges,
    subscriptions,
    transactions,
    users,
  } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const marker = `purge-${Date.now().toString(36)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `${marker}@example.test`, name: "Purge Me" })
    .returning();
  const userId = user!.id;

  // Two connections so resumability is meaningful.
  const connIds: string[] = [];
  for (let c = 0; c < 2; c++) {
    const [conn] = await db
      .insert(connections)
      .values({
        userId,
        plaidItemId: `item-${marker}-${c}`,
        accessTokenEnc: encryptToken(`access-${marker}-${c}`),
        status: "ready",
      })
      .returning();
    connIds.push(conn!.id);
    const [account] = await db
      .insert(accounts)
      .values({
        connectionId: conn!.id,
        plaidAccountId: `acct-${marker}-${c}`,
        name: "Chequing",
        type: "depository",
      })
      .returning();
    await db.insert(transactions).values({
      accountId: account!.id,
      plaidTransactionId: `txn-${marker}-${c}`,
      date: "2026-06-15",
      amount: "18.99",
      currency: "CAD",
      rawDescriptor: "NETFLIX.COM",
    });
    const [sub] = await db
      .insert(subscriptions)
      .values({
        userId,
        streamKey: `${account!.id}:netflix:${c}`,
        accountId: account!.id,
        normalizedMerchant: "netflix",
        cadence: "monthly",
        classification: "subscription",
        verdict: "healthy",
        confidence: "0.9",
        currentAmount: "18.99",
        currency: "CAD",
      })
      .returning();
    await db.insert(priceChanges).values({
      subscriptionId: sub!.id,
      oldAmount: "16.99",
      newAmount: "18.99",
      effectiveDate: "2026-05-15",
    });
    await db.insert(alerts).values({
      userId,
      subscriptionId: sub!.id,
      type: "price_increase",
      dedupKey: `${marker}-${c}:16.99->18.99`,
      payload: { old_amount: "16.99", new_amount: "18.99" },
    });
  }
  await db.insert(alertPreferences).values({ userId, type: "price_increase", emailEnabled: true });

  return { userId, marker };
}

async function rowCounts(userId: string, marker: string): Promise<Record<string, number>> {
  const { sql: rawSql } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const rows = (await db.execute(rawSql`
    select 'users' as t, count(*)::int as n from users where id = ${userId}
    union all select 'connections', count(*)::int from connections where user_id = ${userId}
    union all select 'accounts', count(*)::int from accounts a
      join connections c on a.connection_id = c.id where c.user_id = ${userId}
    union all select 'transactions', count(*)::int from transactions where plaid_transaction_id like ${"txn-" + marker + "%"}
    union all select 'subscriptions', count(*)::int from subscriptions where user_id = ${userId}
    union all select 'price_changes', count(*)::int from price_changes pc
      join subscriptions s on pc.subscription_id = s.id where s.user_id = ${userId}
    union all select 'alerts', count(*)::int from alerts where user_id = ${userId}
    union all select 'alert_preferences', count(*)::int from alert_preferences where user_id = ${userId}
  `)) as unknown as Array<{ t: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

describe.skipIf(!hasDb)("account deletion (live DB, mocked Plaid)", () => {
  it("purges every row, removes Items at Plaid, and is idempotent", async () => {
    const { purgeUser } = await import("@/modules/account/purge");
    const { dispatchAlert } = await import("@/modules/alerts/dispatch");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { alerts } = await import("@/db/schema");
    const { userId, marker } = await setupFullWorld();

    const before = await rowCounts(userId, marker);
    expect(before.users).toBe(1);
    expect(before.connections).toBe(2);
    expect(before.alerts).toBe(2);

    // Remember a pending alert so we can prove its email becomes a no-op.
    const [pendingAlert] = await db.select().from(alerts).where(eq(alerts.userId, userId));

    const removed: string[] = [];
    const result = await purgeUser(userId, async (token) => {
      removed.push(token);
    });
    expect(result.connectionsPurged).toBe(2);
    expect(result.userDeleted).toBe(true);
    expect(removed).toHaveLength(2); // every Item revoked at Plaid

    const after = await rowCounts(userId, marker);
    for (const [table, count] of Object.entries(after)) {
      expect(count, `${table} must be empty`).toBe(0);
    }

    // A queued dispatch job for a purged alert finds nothing and sends nothing.
    let sends = 0;
    const outcome = await dispatchAlert(pendingAlert!.id, async () => {
      sends++;
    });
    expect(outcome).toBe("missing");
    expect(sends).toBe(0);

    // Redelivery of the purge job after completion is a clean no-op.
    const again = await purgeUser(userId, async () => {
      throw new Error("no items should remain");
    });
    expect(again).toEqual({ connectionsPurged: 0, userDeleted: false });
  });

  it("resumes after a mid-purge crash without double-removing at Plaid", async () => {
    const { purgeUser } = await import("@/modules/account/purge");
    const { userId, marker } = await setupFullWorld();

    // First attempt dies on the second connection's Plaid call.
    let calls = 0;
    await expect(
      purgeUser(userId, async () => {
        calls++;
        if (calls === 2) throw new Error("plaid outage");
      }),
    ).rejects.toThrow("plaid outage");

    // One connection fully purged, the user still present: resumable state.
    const mid = await rowCounts(userId, marker);
    expect(mid.users).toBe(1);
    expect(mid.connections).toBe(1);

    // Retry (as the queue would): treats the already-revoked Item as gone
    // and finishes the job.
    const itemGone = Object.assign(new Error("gone"), {
      response: { data: { error_code: "ITEM_NOT_FOUND" } },
    });
    const result = await purgeUser(userId, async () => {
      throw itemGone;
    });
    expect(result.userDeleted).toBe(true);

    const after = await rowCounts(userId, marker);
    for (const [table, count] of Object.entries(after)) {
      expect(count, `${table} must be empty`).toBe(0);
    }
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
