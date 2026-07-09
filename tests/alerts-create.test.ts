import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Stage 7 acceptance: the alert idempotency gate and the dispatch double-send
 * guard, against a live DB with a mocked email sender and mocked queues.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const enqueued = vi.hoisted(() => ({ dispatches: [] as string[] }));
vi.mock("@/lib/queues", () => ({
  enqueueAlertDispatch: async (id: string) => {
    enqueued.dispatches.push(id);
  },
  enqueueDetection: async () => {},
  enqueueSync: async () => {},
}));

async function setupUser(marker: string) {
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  const [user] = await db
    .insert(users)
    .values({ email: `${marker}@example.test` })
    .returning();
  return user!.id;
}

async function setupSubscription(
  userId: string,
  marker: string,
  cadence: "monthly" | "annual" = "monthly",
) {
  const { db } = await import("@/db/client");
  const { accounts, connections, subscriptions } = await import("@/db/schema");
  const { encryptToken } = await import("@/modules/connections/crypto");

  const [conn] = await db
    .insert(connections)
    .values({
      userId,
      plaidItemId: `item-${marker}`,
      accessTokenEnc: encryptToken("x"),
      status: "ready",
      institutionName: "Test Credit Union",
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
      userId,
      streamKey: `${account!.id}:netflix:0`,
      accountId: account!.id,
      normalizedMerchant: "netflix",
      cadence,
      classification: "subscription",
      verdict: "price_increased",
      confidence: "0.92",
      currentAmount: "18.99",
      currency: "CAD",
    })
    .returning();
  return { connectionId: conn!.id, subscriptionId: sub!.id };
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("alert creation gate (live DB)", () => {
  it("firing the same event 10x produces exactly one row and one email send", async () => {
    const { createAlert } = await import("@/modules/alerts/create");
    const { dispatchAlert } = await import("@/modules/alerts/dispatch");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { alerts } = await import("@/db/schema");

    const marker = `al-a-${Date.now().toString(36)}`;
    const userId = await setupUser(marker);
    const { subscriptionId } = await setupSubscription(userId, marker);

    enqueued.dispatches.length = 0;
    const input = {
      userId,
      subscriptionId,
      type: "price_increase" as const,
      dedupKey: "16.99->18.99",
      payload: { old_amount: "16.99", new_amount: "18.99", effective_date: "2026-06-15" },
    };

    const ids: Array<string | null> = [];
    for (let i = 0; i < 10; i++) ids.push(await createAlert(input));

    // One insert, nine conflicts, one dispatch enqueued.
    expect(ids.filter(Boolean)).toHaveLength(1);
    const rows = await db.select().from(alerts).where(eq(alerts.userId, userId));
    expect(rows).toHaveLength(1);
    expect(enqueued.dispatches).toHaveLength(1);

    // The queue delivers (possibly more than once) — the sender fires once.
    const sends: string[] = [];
    const sender = async (msg: { subject: string }) => {
      sends.push(msg.subject);
    };
    expect(await dispatchAlert(rows[0]!.id, sender)).toBe("sent");
    expect(await dispatchAlert(rows[0]!.id, sender)).toBe("already_sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("$16.99");
    expect(sends[0]).toContain("$18.99");

    await cleanup(userId);
  });

  it("redelivery after send-but-before-completion does not double-send", async () => {
    const { createAlert } = await import("@/modules/alerts/create");
    const { dispatchAlert } = await import("@/modules/alerts/dispatch");

    const marker = `al-b-${Date.now().toString(36)}`;
    const userId = await setupUser(marker);
    const { subscriptionId } = await setupSubscription(userId, marker);

    const alertId = (await createAlert({
      userId,
      subscriptionId,
      type: "price_increase",
      dedupKey: "9.99->12.99",
      payload: { old_amount: "9.99", new_amount: "12.99" },
    }))!;

    // First delivery: the send succeeds and sent_at is stamped, but the
    // worker dies before acknowledging — BullMQ redelivers.
    let sends = 0;
    await dispatchAlert(alertId, async () => {
      sends++;
    });
    // Redelivery hits the sent_at guard and never reaches the sender.
    const second = await dispatchAlert(alertId, async () => {
      sends++;
      throw new Error("should never be called");
    });
    expect(second).toBe("already_sent");
    expect(sends).toBe(1);

    await cleanup(userId);
  });

  it("send failure leaves the alert unsent; markSendFailed flags it in-app-only", async () => {
    const { createAlert } = await import("@/modules/alerts/create");
    const { dispatchAlert, markSendFailed } = await import("@/modules/alerts/dispatch");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { alerts } = await import("@/db/schema");

    const marker = `al-c-${Date.now().toString(36)}`;
    const userId = await setupUser(marker);
    const { subscriptionId } = await setupSubscription(userId, marker);

    const alertId = (await createAlert({
      userId,
      subscriptionId,
      type: "price_increase",
      dedupKey: "1.00->2.00",
      payload: { old_amount: "1.00", new_amount: "2.00" },
    }))!;

    await expect(
      dispatchAlert(alertId, async () => {
        throw new Error("resend down");
      }),
    ).rejects.toThrow("resend down");

    await markSendFailed(alertId);
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alertId));
    expect(row!.sentAt).toBeNull();
    expect(row!.sendFailed).toBe(true);

    await cleanup(userId);
  });

  it("email preferences gate dispatch; reauth alerts cannot be disabled", async () => {
    const { createAlert } = await import("@/modules/alerts/create");
    const { dispatchAlert } = await import("@/modules/alerts/dispatch");
    const { setPreference } = await import("@/modules/alerts/preferences");

    const marker = `al-d-${Date.now().toString(36)}`;
    const userId = await setupUser(marker);
    const { connectionId, subscriptionId } = await setupSubscription(userId, marker, "monthly");

    // upcoming_charge on a MONTHLY subscription: default OFF → in-app only.
    const monthlyUpcoming = (await createAlert({
      userId,
      subscriptionId,
      type: "upcoming_charge",
      dedupKey: "2026-07-20",
      payload: { expected_date: "2026-07-20", cadence: "monthly", amount: "18.99" },
    }))!;
    let sends = 0;
    const sender = async () => {
      sends++;
    };
    expect(await dispatchAlert(monthlyUpcoming, sender)).toBe("email_disabled");
    expect(sends).toBe(0);

    // Explicit opt-in flips it.
    await setPreference(userId, "upcoming_charge", true);
    expect(await dispatchAlert(monthlyUpcoming, sender)).toBe("sent");
    expect(sends).toBe(1);

    // price_increase can be opted out.
    await setPreference(userId, "price_increase", false);
    const priceAlert = (await createAlert({
      userId,
      subscriptionId,
      type: "price_increase",
      dedupKey: "5.00->6.00",
      payload: { old_amount: "5.00", new_amount: "6.00" },
    }))!;
    expect(await dispatchAlert(priceAlert, sender)).toBe("email_disabled");

    // reauth_required has no off switch — always emailed.
    const reauth = (await createAlert({
      userId,
      connectionId,
      type: "reauth_required",
      dedupKey: `${connectionId}:2026-W28`,
      payload: { institution_name: "Test Credit Union" },
    }))!;
    expect(await dispatchAlert(reauth, sender)).toBe("sent");
    expect(sends).toBe(2);

    await cleanup(userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
