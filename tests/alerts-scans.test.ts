import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Stage 7 scheduled scans against a live DB: renewal window boundaries,
 * idempotent re-runs, staleness → degraded, and the reconciliation sweep
 * healing a manufactured lost-event scenario.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const enqueued = vi.hoisted(() => ({ dispatches: [] as string[], detections: [] as string[] }));
vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async (id: string) => {
    enqueued.dispatches.push(id);
  },
  enqueueDetection: async (userId: string) => {
    enqueued.detections.push(userId);
  },
  enqueueSync: async () => {},
}));

const DAY = 86_400_000;

function isoIn(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);
}

async function setupWorld(marker: string) {
  const { db } = await import("@/db/client");
  const { accounts, connections, users } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const [user] = await db
    .insert(users)
    .values({ email: `${marker}@example.test` })
    .returning();
  const [conn] = await db
    .insert(connections)
    .values({
      userId: user!.id,
      plaidItemId: `item-${marker}`,
      accessTokenEnc: encryptToken("x"),
      status: "ready",
      institutionName: "Scan Test Bank",
      lastSyncedAt: new Date(),
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
  return { userId: user!.id, connectionId: conn!.id, accountId: account!.id };
}

async function addSubscription(
  userId: string,
  accountId: string,
  marker: string,
  cadence: "monthly" | "quarterly" | "annual",
  nextExpectedDate: string,
) {
  const { db } = await import("@/db/client");
  const { subscriptions } = await import("@/db/schema");
  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId,
      streamKey: `${accountId}:${marker}:0`,
      accountId,
      normalizedMerchant: marker,
      cadence,
      classification: "subscription",
      verdict: "healthy",
      confidence: "0.9",
      currentAmount: "99.00",
      currency: "CAD",
      nextExpectedDate,
    })
    .returning();
  return sub!.id;
}

async function alertsFor(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { alerts } = await import("@/db/schema");
  return db.select().from(alerts).where(eq(alerts.userId, userId));
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("daily scans (live DB)", () => {
  it("renewal scan honors the 30-day window and cadence filter, once per renewal", async () => {
    const { renewalScan } = await import("@/modules/alerts/scans");
    const now = new Date();
    const marker = `scan-a-${Date.now().toString(36)}`;
    const { userId, accountId } = await setupWorld(marker);

    await addSubscription(userId, accountId, `${marker}-in`, "annual", isoIn(now, 20));
    await addSubscription(userId, accountId, `${marker}-edge`, "quarterly", isoIn(now, 30));
    await addSubscription(userId, accountId, `${marker}-out`, "annual", isoIn(now, 31));
    await addSubscription(userId, accountId, `${marker}-monthly`, "monthly", isoIn(now, 10));
    await addSubscription(userId, accountId, `${marker}-past`, "annual", isoIn(now, -1));

    // Scans sweep the whole DB, so assert on OUR user's alerts, not the
    // global count — parallel tests and dev data would pollute it.
    await renewalScan(now);
    const rows = await alertsFor(userId);
    expect(rows).toHaveLength(2); // 20 days + the 30-day edge
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(["renewal_upcoming"]));

    // Second run: the dedup gate swallows everything.
    await renewalScan(now);
    expect(await alertsFor(userId)).toHaveLength(2);

    await cleanup(userId);
  });

  it("upcoming-charge scan looks 3 days out for any cadence", async () => {
    const { upcomingChargeScan } = await import("@/modules/alerts/scans");
    const now = new Date();
    const marker = `scan-b-${Date.now().toString(36)}`;
    const { userId, accountId } = await setupWorld(marker);

    await addSubscription(userId, accountId, `${marker}-soon`, "monthly", isoIn(now, 2));
    await addSubscription(userId, accountId, `${marker}-later`, "monthly", isoIn(now, 4));

    await upcomingChargeScan(now);
    await upcomingChargeScan(now); // idempotent re-run
    const rows = await alertsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("upcoming_charge");
    expect((rows[0]!.payload as { cadence: string }).cadence).toBe("monthly");

    await cleanup(userId);
  });

  it("staleness scan degrades quiet connections and alerts once per week", async () => {
    const { stalenessScan } = await import("@/modules/alerts/scans");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections } = await import("@/db/schema");

    const now = new Date();
    const marker = `scan-c-${Date.now().toString(36)}`;
    const { userId, connectionId } = await setupWorld(marker);

    // 4 days since the last successful sync while looking healthy.
    await db
      .update(connections)
      .set({ lastSyncedAt: new Date(now.getTime() - 4 * DAY) })
      .where(eq(connections.id, connectionId));

    enqueued.dispatches.length = 0;
    await stalenessScan(now);

    const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(conn!.status).toBe("degraded");
    const rows = await alertsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("reauth_required");
    expect(rows[0]!.connectionId).toBe(connectionId);
    expect(enqueued.dispatches).toContain(rows[0]!.id);

    // Re-run: already degraded, no longer selected, nothing new for this user.
    await stalenessScan(now);
    expect(await alertsFor(userId)).toHaveLength(1);

    await cleanup(userId);
  });

  it("reconciliation sweep heals a lost-event scenario", async () => {
    const { reconciliationSweep } = await import("@/modules/alerts/scans");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections, transactions } = await import("@/db/schema");

    const marker = `scan-d-${Date.now().toString(36)}`;
    const { userId, connectionId, accountId } = await setupWorld(marker);

    // The manufactured loss: a transaction landed AFTER the last detection
    // run (the detection enqueue was lost, say a worker crash).
    await db
      .update(connections)
      .set({ lastDetectionAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(connections.id, connectionId));
    await db.insert(transactions).values({
      accountId,
      plaidTransactionId: `txn-${marker}`,
      date: new Date().toISOString().slice(0, 10),
      amount: "12.99",
      currency: "CAD",
      rawDescriptor: "LOST EVENT LTD",
    });

    const detections: string[] = [];
    const healed = await reconciliationSweep(async (uid) => {
      detections.push(uid);
    });
    expect(healed).toBeGreaterThanOrEqual(1);
    expect(detections).toContain(userId);

    // Detection has since run: nothing to heal for this user anymore.
    await db
      .update(connections)
      .set({ lastDetectionAt: new Date(Date.now() + 1000) })
      .where(eq(connections.id, connectionId));
    const detectionsAfter: string[] = [];
    await reconciliationSweep(async (uid) => {
      detectionsAfter.push(uid);
    });
    expect(detectionsAfter).not.toContain(userId);

    await cleanup(userId);
  });

  it("re-enqueues connections stuck in syncing for 30+ minutes", async () => {
    const { stuckSyncScan } = await import("@/modules/alerts/scans");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections } = await import("@/db/schema");

    const now = new Date();
    const marker = `scan-e-${Date.now().toString(36)}`;
    const { userId, connectionId } = await setupWorld(marker);

    // Stuck: syncing with no progress for 40 minutes.
    await db
      .update(connections)
      .set({ status: "syncing", updatedAt: new Date(now.getTime() - 40 * 60_000) })
      .where(eq(connections.id, connectionId));

    const resynced: string[] = [];
    await stuckSyncScan(now, async (id) => {
      resynced.push(id);
    });
    expect(resynced).toContain(connectionId);

    // Freshly-started syncs are left alone.
    await db
      .update(connections)
      .set({ updatedAt: new Date() })
      .where(eq(connections.id, connectionId));
    const resyncedAfter: string[] = [];
    await stuckSyncScan(now, async (id) => {
      resyncedAfter.push(id);
    });
    expect(resyncedAfter).not.toContain(connectionId);

    await cleanup(userId);
  });

  it("finishes the purge for orphaned revoking connections", async () => {
    const { orphanedRevokingScan } = await import("@/modules/alerts/scans");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections } = await import("@/db/schema");

    const marker = `scan-f-${Date.now().toString(36)}`;
    const { userId, connectionId } = await setupWorld(marker);
    await db
      .update(connections)
      .set({ status: "revoking" })
      .where(eq(connections.id, connectionId));

    // Plaid says the Item is already gone — that still finishes the purge.
    const itemGone = Object.assign(new Error("gone"), {
      response: { data: { error_code: "ITEM_NOT_FOUND" } },
    });
    await orphanedRevokingScan(async () => {
      throw itemGone;
    });

    const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(row).toBeUndefined();

    await cleanup(userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
