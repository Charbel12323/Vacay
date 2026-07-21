import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Stage 9 cache-aside acceptance: second read is a hit, a user PATCH is
 * reflected on the immediately following read (invariant 8), and TTLs carry
 * jitter so keys never expire in lockstep.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const sessionUser = vi.hoisted(() => ({ id: "", email: "cache@example.test" }));
vi.mock("@/modules/api/require-user", () => ({
  requireUser: async () => sessionUser,
}));
vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async () => {},
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
}));

async function setupWorld() {
  const { db } = await import("@/db/client");
  const { accounts, connections, subscriptions, users } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const marker = `cache-${Date.now().toString(36)}`;
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
    })
    .returning();
  return { userId: user!.id, subId: sub!.id };
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("dashboard cache-aside (live DB + Redis)", () => {
  it("misses, then hits, then a PATCH invalidates before its response", async () => {
    const { GET: getSummary } = await import("@/app/api/subscriptions/summary/route");
    const { GET: getList } = await import("@/app/api/subscriptions/route");
    const routes = await import("@/app/api/subscriptions/[id]/route");
    const { userId, subId } = await setupWorld();
    sessionUser.id = userId;

    // Cold: miss and rebuild. Warm: served from Redis.
    let res = await getSummary();
    expect(res.headers.get("x-cache")).toBe("miss");
    res = await getSummary();
    expect(res.headers.get("x-cache")).toBe("hit");
    expect((await res.json()).monthly_recurring).toBe("18.99");

    const listReq = () => new NextRequest("http://x/api/subscriptions?status=active");
    res = await getList(listReq());
    expect(res.headers.get("x-cache")).toBe("miss");
    res = await getList(listReq());
    expect(res.headers.get("x-cache")).toBe("hit");
    expect((await res.json()).subscriptions).toHaveLength(1);

    // The write kills the cached views BEFORE responding, so the very next
    // read shows the change (read-your-own-writes, invariant 8).
    await routes.PATCH(
      new NextRequest("http://x", {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      }),
      { params: Promise.resolve({ id: subId }) },
    );

    res = await getSummary();
    expect(res.headers.get("x-cache")).toBe("miss"); // invalidated
    const summary = await res.json();
    expect(summary.monthly_recurring).toBe("0.00");
    expect(summary.total_saved).toBe("18.99");

    res = await getList(listReq());
    expect(res.headers.get("x-cache")).toBe("miss");
    expect((await res.json()).subscriptions).toHaveLength(0);

    await cleanup(userId);
  });

  it("cached keys carry jittered TTLs within [480, 720] seconds", async () => {
    const { GET: getSummary } = await import("@/app/api/subscriptions/summary/route");
    const { summaryKey } = await import("@/lib/cache");
    const { createRedis } = await import("@/lib/redis");
    const { userId } = await setupWorld();
    sessionUser.id = userId;

    await getSummary();
    const redis = createRedis();
    const ttl = await redis.ttl(summaryKey(userId));
    await redis.quit();
    expect(ttl).toBeGreaterThanOrEqual(480 - 2);
    expect(ttl).toBeLessThanOrEqual(720);

    await cleanup(userId);
  });

  it("filter hashes are stable and order-insensitive", async () => {
    const { filterHash } = await import("@/lib/cache");
    expect(filterHash({ status: "active", verdict: undefined })).toBe(
      filterHash({ verdict: undefined, status: "active" }),
    );
    expect(filterHash({ status: "active" })).not.toBe(filterHash({ status: "dismissed" }));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
