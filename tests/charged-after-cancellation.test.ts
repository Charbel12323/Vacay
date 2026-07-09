import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Stage 8 acceptance: a charge landing after the user cancelled produces
 * exactly ONE charged_after_cancellation alert, however many times detection
 * re-runs (the dedup gate: charge date + amount).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async () => {},
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
}));

const DAY = 86_400_000;

function isoDaysAgo(days: number, dayShift = 0): string {
  const d = new Date(Date.now() - days * DAY + dayShift);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!hasDb)("charged after cancellation (live DB, real engine)", () => {
  it("one alert per post-cancellation charge, idempotent across re-runs", async () => {
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { accounts, alerts, connections, subscriptions, transactions, users } =
      await import("@/db/schema");
    const { encryptToken } = await import("@/modules/connections/crypto");
    const { runDetection } = await import("@/modules/detection/orchestrator");

    const marker = `cac-${Date.now().toString(36)}`;
    const [user] = await db
      .insert(users)
      .values({ email: `${marker}@example.test` })
      .returning();
    const userId = user!.id;
    const [conn] = await db
      .insert(connections)
      .values({
        userId,
        plaidItemId: `item-${marker}`,
        accessTokenEnc: encryptToken("x"),
        status: "ready",
      })
      .returning();
    const [account] = await db
      .insert(accounts)
      .values({
        connectionId: conn!.id,
        plaidAccountId: `acct-${marker}`,
        name: "Chequing",
        type: "depository",
        mask: "0000",
      })
      .returning();

    // Six clean monthly Netflix charges, the newest ~40 days ago.
    const chargeDays = [40, 70, 100, 130, 160, 190];
    await db.insert(transactions).values(
      chargeDays.map((days, i) => ({
        accountId: account!.id,
        plaidTransactionId: `txn-${marker}-${i}`,
        date: isoDaysAgo(days),
        amount: "18.99",
        currency: "CAD",
        rawDescriptor: "NETFLIX.COM",
      })),
    );

    // Detection asserts the stream; then the user cancels 20 days ago.
    await runDetection(userId);
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));
    expect(sub, "detection must assert the netflix stream").toBeTruthy();
    await db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(subscriptions.id, sub!.id));

    // The merchant charges anyway, 10 days ago — after the cancellation.
    await db.insert(transactions).values({
      accountId: account!.id,
      plaidTransactionId: `txn-${marker}-post`,
      date: isoDaysAgo(10),
      amount: "18.99",
      currency: "CAD",
      rawDescriptor: "NETFLIX.COM",
    });

    const alertsFor = () =>
      db
        .select()
        .from(alerts)
        .where(and(eq(alerts.userId, userId), eq(alerts.type, "charged_after_cancellation")));

    await runDetection(userId);
    let rows = await alertsFor();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { charge_date: string }).charge_date).toBe(isoDaysAgo(10));
    expect(rows[0]!.subscriptionId).toBe(sub!.id);

    // Re-running detection over the same world changes nothing (invariant 4).
    await runDetection(userId);
    await runDetection(userId);
    rows = await alertsFor();
    expect(rows).toHaveLength(1);

    // And the stream stays cancelled — the engine never resurrects it.
    const [after] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(after!.status).toBe("cancelled");

    await db.delete(users).where(eq(users.id, userId));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
