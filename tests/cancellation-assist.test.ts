import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Assist resolution against a live DB: seeded merchants get real
 * instructions, unknown merchants get the generic payload (never a 404),
 * drafts pick the right template, telemetry logs merchant-level only, and
 * mark-as-cancelled feeds total_saved immediately.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const sessionUser = vi.hoisted(() => ({ id: "", email: "assist@example.test" }));
vi.mock("@/modules/api/require-user", () => ({
  requireUser: async () => sessionUser,
}));
vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async () => {},
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
}));

async function setupWorld(
  merchantName: string | null,
  verdict: "healthy" | "price_increased" = "healthy",
) {
  const { eq, sql: rawSql } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { accounts, connections, merchants, subscriptions, users } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const marker = `assist-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `${marker}@example.test`, name: "Charbel M" })
    .returning();
  const [conn] = await db
    .insert(connections)
    .values({
      userId: user!.id,
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

  let merchantId: string | null = null;
  let normalized = `unknown merchant ${marker}`;
  if (merchantName) {
    const [m] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.name, merchantName));
    merchantId = m?.id ?? null;
    normalized = merchantName.toLowerCase();
    expect(merchantId, `merchant ${merchantName} must be seeded`).toBeTruthy();
    void rawSql;
  }

  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId: user!.id,
      streamKey: `${account!.id}:${normalized}:0`,
      accountId: account!.id,
      merchantId,
      normalizedMerchant: normalized,
      cadence: "monthly",
      classification: "subscription",
      verdict,
      confidence: "0.92",
      currentAmount: "18.99",
      currency: "CAD",
    })
    .returning();
  return { userId: user!.id, subId: sub!.id, marker };
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("cancellation assist (live DB)", () => {
  it("returns verified instructions and a cancellation draft context for a seeded merchant", async () => {
    const { buildAssistPayload } = await import("@/modules/cancellation/assist");
    const { userId, subId } = await setupWorld("Netflix");

    const assist = await buildAssistPayload(subId, userId);
    expect(assist).not.toBeNull();
    expect(assist!.had_data).toBe(true);
    expect(assist!.merchant).toBe("Netflix");
    expect(assist!.method).toBe("web");
    expect(assist!.url).toContain("netflix.com");
    expect(assist!.steps.length).toBeGreaterThan(0);
    // Netflix is a web self-serve cancel — no message needed, no draft.
    expect(assist!.draft).toBeNull();

    await cleanup(userId);
  });

  it("renders a price-match draft after a price increase", async () => {
    const { buildAssistPayload } = await import("@/modules/cancellation/assist");
    const { db } = await import("@/db/client");
    const { priceChanges } = await import("@/db/schema");
    // SiriusXM: chat method with a template — drafts apply.
    const { userId, subId } = await setupWorld("SiriusXM", "price_increased");
    await db.insert(priceChanges).values({
      subscriptionId: subId,
      oldAmount: "16.99",
      newAmount: "18.99",
      effectiveDate: "2026-06-15",
    });

    const assist = await buildAssistPayload(subId, userId);
    expect(assist!.draft).not.toBeNull();
    expect(assist!.draft!.template_id).toBe("price_match");
    expect(assist!.draft!.body).toContain("$16.99");
    expect(assist!.draft!.body).toContain("$18.99");
    expect(assist!.draft!.body).toContain("Charbel"); // first name only
    expect(assist!.draft!.body).not.toContain("Charbel M");
    expect(assist!.draft!.body).not.toMatch(/\{\{/);

    await cleanup(userId);
  });

  it("unknown merchant gets the generic payload, never a 404", async () => {
    const routes = await import("@/app/api/subscriptions/[id]/cancellation/route");
    const { userId, subId } = await setupWorld(null);
    sessionUser.id = userId;

    const res = await routes.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ id: subId }),
    });
    expect(res.status).toBe(200);
    const { assist } = await res.json();
    expect(assist.had_data).toBe(false);
    expect(assist.method).toBe("unknown");
    expect(assist.steps.length).toBeGreaterThanOrEqual(3);

    // Someone else's subscription IS a 404 — only merchants are never-404.
    sessionUser.id = "00000000-0000-4000-8000-000000000000";
    const foreign = await routes.GET(new NextRequest("http://x"), {
      params: Promise.resolve({ id: subId }),
    });
    expect(foreign.status).toBe(404);

    sessionUser.id = userId;
    await cleanup(userId);
  });

  it("logs merchant-level telemetry with had_data and no user reference", async () => {
    const { buildAssistPayload } = await import("@/modules/cancellation/assist");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { assistOpens } = await import("@/db/schema");
    const { userId, subId, marker } = await setupWorld(null);

    await buildAssistPayload(subId, userId);
    await buildAssistPayload(subId, userId);

    const rows = await db
      .select()
      .from(assistOpens)
      .where(eq(assistOpens.merchant, `unknown merchant ${marker}`));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.hadData).toBe(false);
      // The row type itself carries nothing user-shaped; sanity-check values.
      expect(JSON.stringify(row)).not.toContain(userId);
    }

    await cleanup(userId);
  });

  it("mark-as-cancelled moves the amount into total_saved immediately", async () => {
    const subRoutes = await import("@/app/api/subscriptions/[id]/route");
    const { GET: getSummary } = await import("@/app/api/subscriptions/summary/route");
    const { userId, subId } = await setupWorld("Netflix");
    sessionUser.id = userId;

    let summary = await (await getSummary()).json();
    expect(summary.monthly_recurring).toBe("18.99");
    expect(summary.total_saved).toBe("0.00");

    const res = await subRoutes.PATCH(
      new NextRequest("http://x", {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      }),
      { params: Promise.resolve({ id: subId }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).subscription.status).toBe("cancelled");

    // Read-your-own-writes: the very next summary reflects it.
    summary = await (await getSummary()).json();
    expect(summary.monthly_recurring).toBe("0.00");
    expect(summary.total_saved).toBe("18.99");

    await cleanup(userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
