import { afterAll, describe, expect, it } from "vitest";

/**
 * Detection orchestration against a live DB: correct persistence on the
 * first run, ZERO row changes on the second (stage acceptance / invariant 4).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("detection orchestrator (live DB)", () => {
  it("persists streams, price changes, links, and events — idempotently", async () => {
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const {
      accounts,
      alerts,
      connections,
      merchants,
      priceChanges,
      subscriptions,
      transactions,
      users,
    } = await import("@/db/schema");
    const { encryptToken } = await import("@/modules/connections/crypto");
    const { runDetection } = await import("@/modules/detection/orchestrator");

    // Letters-only marker: the normalizer strips long digit runs, so a
    // digit-heavy alias would never match its own descriptor.
    const marker = `stage5-${Date.now()
      .toString(36)
      .replace(/\d/g, (d) => "ghijklmnop"[+d]!)}`;

    const [user] = await db
      .insert(users)
      .values({ email: `${marker}@example.test` })
      .returning();
    const [conn] = await db
      .insert(connections)
      .values({
        userId: user!.id,
        plaidItemId: `item-${marker}`,
        accessTokenEnc: encryptToken("access-test"),
        status: "ok",
      })
      .returning();
    const [account] = await db
      .insert(accounts)
      .values({
        connectionId: conn!.id,
        plaidAccountId: `acct-${marker}`,
        name: "Chequing",
        type: "depository",
      })
      .returning();
    const [merchant] = await db
      .insert(merchants)
      .values({
        name: `Testflix-${marker}`,
        aliases: [`testflix-${marker}.com`],
        category: "streaming",
        knownPlans: [],
      })
      .returning();

    // Netflix-style price increase: 16.99 ×4 then 18.99 ×2, monthly on the 15th.
    const months = ["01", "02", "03", "04", "05", "06"];
    const amounts = ["16.99", "16.99", "16.99", "16.99", "18.99", "18.99"];
    await db.insert(transactions).values(
      months.map((mm, i) => ({
        accountId: account!.id,
        plaidTransactionId: `txn-${marker}-${i}`,
        date: `2026-${mm}-15`,
        amount: amounts[i]!,
        currency: "CAD",
        rawDescriptor: `TESTFLIX-${marker}.COM`,
      })),
    );

    // ---- First run ----------------------------------------------------------
    const first = await runDetection(user!.id);
    expect(first.streams).toBe(1);
    expect(first.created).toBe(1);
    expect(first.events).toBe(1); // the price_increase alert row

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user!.id));
    expect(sub).toBeDefined();
    expect(sub!.cadence).toBe("monthly");
    expect(sub!.classification).toBe("subscription");
    expect(sub!.verdict).toBe("price_increased");
    expect(Number(sub!.confidence)).toBeGreaterThanOrEqual(0.8);
    expect(sub!.merchantId).toBe(merchant!.id);
    expect(sub!.currentAmount).toBe("18.99");

    const linked = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.accountId, account!.id), eq(transactions.subscriptionId, sub!.id)),
      );
    expect(linked).toHaveLength(6);

    const pcs = await db
      .select()
      .from(priceChanges)
      .where(eq(priceChanges.subscriptionId, sub!.id));
    expect(pcs).toHaveLength(1);
    expect(pcs[0]!.oldAmount).toBe("16.99");
    expect(pcs[0]!.newAmount).toBe("18.99");

    const alertRows = await db.select().from(alerts).where(eq(alerts.userId, user!.id));
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.type).toBe("price_increase");
    expect(alertRows[0]!.dedupKey).toBe("16.99->18.99");
    expect(alertRows[0]!.sentAt).toBeNull(); // persisted, not sent (Stage 7)

    // Connection graduated ok → ready after first detection.
    const [connAfter] = await db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, conn!.id));
    expect(connAfter!.status).toBe("ready");

    // ---- Second run: zero changes ------------------------------------------
    const before = await db.select().from(subscriptions).where(eq(subscriptions.userId, user!.id));

    const second = await runDetection(user!.id);
    expect(second).toEqual({ streams: 1, created: 0, updated: 0, events: 0 });

    const after = await db.select().from(subscriptions).where(eq(subscriptions.userId, user!.id));
    expect(after).toEqual(before); // includes updatedAt — literally no row change

    expect(
      await db.select().from(priceChanges).where(eq(priceChanges.subscriptionId, sub!.id)),
    ).toHaveLength(1);
    expect(await db.select().from(alerts).where(eq(alerts.userId, user!.id))).toHaveLength(1);

    // ---- Feedback suppression ----------------------------------------------
    await db
      .update(subscriptions)
      .set({ userConfirmed: false })
      .where(eq(subscriptions.id, sub!.id));
    const third = await runDetection(user!.id);
    expect(third.streams).toBe(1);
    const [subAfterFeedback] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sub!.id));
    expect(subAfterFeedback!.status).toBe("dismissed");
    expect(subAfterFeedback!.verdict).toBeNull();

    // Cleanup.
    await db.delete(users).where(eq(users.id, user!.id));
    await db.delete(merchants).where(eq(merchants.id, merchant!.id));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
