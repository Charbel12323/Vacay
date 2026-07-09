import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Feed API acceptance: cursor pagination without overlap, the PATCH
 * whitelist, cross-user isolation, and unread counts staying correct under
 * concurrent reads and writes.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const sessionUser = vi.hoisted(() => ({ id: "", email: "feed@example.test" }));
vi.mock("@/modules/api/require-user", () => ({
  requireUser: async () => sessionUser,
}));
vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async () => {},
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
}));

const TOTAL = 35; // one over the 30-row page size

async function setupWorld() {
  const { db } = await import("@/db/client");
  const { alerts, users } = await import("@/db/schema");

  const marker = `feed-${Date.now().toString(36)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `${marker}@example.test` })
    .returning();

  // NULL subscription_id rows share one dedup namespace (NULLS NOT
  // DISTINCT), so keys must be marker-scoped — same convention as real
  // connection-level alerts embedding their connection id.
  const rows = await db
    .insert(alerts)
    .values(
      Array.from({ length: TOTAL }, (_, i) => ({
        userId: user!.id,
        type: "price_increase" as const,
        dedupKey: `${marker}:${i}.00->${i + 1}.00`,
        payload: { old_amount: `${i}.00`, new_amount: `${i + 1}.00` },
      })),
    )
    .returning({ id: alerts.id });
  return { userId: user!.id, alertIds: rows.map((r) => r.id) };
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

function listReq(cursor?: string) {
  const url = cursor
    ? `http://x/api/alerts?cursor=${encodeURIComponent(cursor)}`
    : "http://x/api/alerts";
  return new NextRequest(url);
}

describe.skipIf(!hasDb)("alert feed APIs (live DB)", () => {
  it("paginates without overlap and counts unread correctly", async () => {
    const { GET } = await import("@/app/api/alerts/route");
    const routes = await import("@/app/api/alerts/[id]/route");
    const { userId } = await setupWorld();
    sessionUser.id = userId;

    // Page 1: full page + cursor.
    let res = await GET(listReq());
    let body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alerts).toHaveLength(30);
    expect(body.unread_count).toBe(TOTAL);
    expect(body.next_cursor).toBeTruthy();

    // Page 2: the remainder, no overlap with page 1.
    const seen = new Set(body.alerts.map((a: { id: string }) => a.id));
    res = await GET(listReq(body.next_cursor));
    body = await res.json();
    expect(body.alerts).toHaveLength(TOTAL - 30);
    expect(body.next_cursor).toBeNull();
    for (const a of body.alerts) expect(seen.has(a.id)).toBe(false);

    // Mark one read → reflected immediately (read-your-own-writes).
    const targetId = body.alerts[0].id;
    res = await routes.PATCH(
      new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ read: true }) }),
      { params: Promise.resolve({ id: targetId }) },
    );
    expect(res.status).toBe(200);
    res = await GET(listReq());
    body = await res.json();
    expect(body.unread_count).toBe(TOTAL - 1);

    await cleanup(userId);
  });

  it("PATCH accepts exactly { read: true } and nothing else", async () => {
    const routes = await import("@/app/api/alerts/[id]/route");
    const { userId, alertIds } = await setupWorld();
    sessionUser.id = userId;

    for (const bad of [{ read: false }, { read: true, extra: 1 }, { dismissed: true }, {}, null]) {
      const res = await routes.PATCH(
        new NextRequest("http://x", { method: "PATCH", body: JSON.stringify(bad) }),
        { params: Promise.resolve({ id: alertIds[0]! }) },
      );
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }

    // Another user's alert: NOT_FOUND, not forbidden-but-confirmed-to-exist.
    sessionUser.id = "00000000-0000-4000-8000-000000000000";
    const res = await routes.PATCH(
      new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ read: true }) }),
      { params: Promise.resolve({ id: alertIds[0]! }) },
    );
    expect(res.status).toBe(404);

    sessionUser.id = userId;
    await cleanup(userId);
  });

  it("unread counts stay correct under concurrent reads and writes", async () => {
    const { GET } = await import("@/app/api/alerts/route");
    const routes = await import("@/app/api/alerts/[id]/route");
    const { userId, alertIds } = await setupWorld();
    sessionUser.id = userId;

    // 10 different alerts marked read concurrently, the same alert patched
    // twice (idempotent), interleaved with reads.
    const toRead = alertIds.slice(0, 10);
    const patches = [...toRead, toRead[0]!].map((id) =>
      routes.PATCH(
        new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ read: true }) }),
        { params: Promise.resolve({ id }) },
      ),
    );
    const reads = Array.from({ length: 5 }, () => GET(listReq()));
    const results = await Promise.all([...patches, ...reads]);
    for (const res of results) expect(res.status).toBe(200);

    // Every concurrent read saw a consistent snapshot (a count in [25, 35],
    // never negative or double-decremented past the truth) …
    for (const res of results.slice(patches.length)) {
      const { unread_count } = await res.clone().json();
      expect(unread_count).toBeGreaterThanOrEqual(TOTAL - 10);
      expect(unread_count).toBeLessThanOrEqual(TOTAL);
    }

    // … and the settled state is exact: 10 read, 25 unread, despite the
    // duplicate patch.
    const finalBody = await (await GET(listReq())).json();
    expect(finalBody.unread_count).toBe(TOTAL - 10);

    await cleanup(userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
