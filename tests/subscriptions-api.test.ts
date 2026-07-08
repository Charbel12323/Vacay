import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route-level tests for the Stage 6 product APIs against a live DB, calling
 * the handlers directly with a mocked session (requireUser is mocked; every
 * other layer is real).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const sessionUser = vi.hoisted(() => ({ id: "", email: "test@example.test" }));
vi.mock("@/modules/api/require-user", () => ({
  requireUser: async () => sessionUser,
}));
// Don't enqueue real jobs from tests — the queue side is covered elsewhere.
const enqueued = vi.hoisted(() => ({ detections: 0 }));
vi.mock("@/lib/queues", () => ({
  enqueueDetection: async () => {
    enqueued.detections++;
  },
  enqueueSync: async () => {},
}));

async function setupWorld() {
  const { db } = await import("@/db/client");
  const { accounts, connections, subscriptions, transactions, users } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const marker = `stage6-${Date.now().toString(36)}`;
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

  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId: user!.id,
      streamKey: `${account!.id}:netflix:0`,
      accountId: account!.id,
      normalizedMerchant: "netflix",
      cadence: "monthly",
      classification: "subscription",
      verdict: "healthy",
      confidence: "0.92",
      currentAmount: "18.99",
      currency: "CAD",
      firstChargeDate: "2026-01-15",
      lastChargeDate: "2026-06-15",
      nextExpectedDate: "2026-07-15",
    })
    .returning();

  await db.insert(transactions).values([
    {
      accountId: account!.id,
      plaidTransactionId: `txn-${marker}-1`,
      subscriptionId: sub!.id,
      date: "2026-06-15",
      amount: "18.99",
      currency: "CAD",
      rawDescriptor: "NETFLIX.COM",
    },
    {
      accountId: account!.id,
      plaidTransactionId: `txn-${marker}-2`,
      subscriptionId: sub!.id,
      date: "2026-05-15",
      amount: "18.99",
      currency: "CAD",
      rawDescriptor: "NETFLIX.COM",
    },
  ]);

  return { userId: user!.id, subId: sub!.id, accountId: account!.id };
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("subscriptions APIs (live DB)", () => {
  it("summary, list, detail, and the PATCH contract", async () => {
    const world = await setupWorld();
    sessionUser.id = world.userId;

    // Summary.
    const { GET: getSummary } = await import("@/app/api/subscriptions/summary/route");
    let res = await getSummary();
    let body = await res.json();
    expect(res.status).toBe(200);
    expect(body.monthly_recurring).toBe("18.99");
    expect(body.active_count).toBe(1);
    expect(typeof body.as_of).toBe("string");

    // List.
    const { GET: getList } = await import("@/app/api/subscriptions/route");
    res = await getList(new NextRequest("http://x/api/subscriptions?status=active"));
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].merchant).toBe("netflix");
    expect(body.subscriptions[0].account_mask).toBe("0000");
    expect(body.subscriptions[0].current_amount).toBe("18.99"); // string, never float

    // Detail with evidence.
    const routes = await import("@/app/api/subscriptions/[id]/route");
    res = await routes.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ id: world.subId }),
    });
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.evidence).toHaveLength(2);
    expect(body.evidence[0].raw_descriptor).toBe("NETFLIX.COM");

    // PATCH whitelist: anything else is 422.
    for (const bad of [
      { user_confirmed: true, status: "dismissed" },
      { status: "cancelled" },
      { verdict: "healthy" },
      { user_confirmed: "yes" },
      {},
    ]) {
      res = await routes.PATCH(
        new NextRequest("http://x", { method: "PATCH", body: JSON.stringify(bad) }),
        { params: Promise.resolve({ id: world.subId }) },
      );
      expect(res.status, JSON.stringify(bad)).toBe(422);
      const envelope = await res.json();
      expect(envelope.error.code).toBe("VALIDATION_FAILED");
    }

    // Reject: read-your-own-writes — gone from the active list immediately.
    res = await routes.PATCH(
      new NextRequest("http://x", {
        method: "PATCH",
        body: JSON.stringify({ user_confirmed: false }),
      }),
      { params: Promise.resolve({ id: world.subId }) },
    );
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.subscription.status).toBe("dismissed");
    expect(body.subscription.user_confirmed).toBe(false);

    res = await getList(new NextRequest("http://x/api/subscriptions?status=active"));
    body = await res.json();
    expect(body.subscriptions).toHaveLength(0);
    expect(enqueued.detections).toBe(1); // incremental re-detection requested

    // Evidence transactions unlinked.
    const { eq, isNull, and: andOp } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { transactions } = await import("@/db/schema");
    const unlinked = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        andOp(eq(transactions.accountId, world.accountId), isNull(transactions.subscriptionId)),
      );
    expect(unlinked).toHaveLength(2);

    // Cross-user 404: another user's session sees nothing.
    sessionUser.id = "00000000-0000-4000-8000-000000000000";
    res = await routes.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ id: world.subId }),
    });
    expect(res.status).toBe(404);

    sessionUser.id = world.userId;
    await cleanup(world.userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
