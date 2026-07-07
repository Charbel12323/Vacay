import { afterAll, describe, expect, it } from "vitest";
import type { SyncPage } from "@/modules/connections/plaid";

/**
 * Integration tests for the sync engine (Stage 4 acceptance) against a real
 * database with a mocked Plaid page fetcher producing deterministic pages.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

function makeTxn(id: string, amount: number, date = "2026-06-01") {
  return {
    plaidTransactionId: id,
    plaidAccountId: "plaid-acct-sync-test",
    date,
    amount,
    currency: "CAD",
    rawDescriptor: `NETFLIX.COM ${id}`,
    pending: false,
    pfcPrimary: "ENTERTAINMENT",
    pfcDetailed: null,
    legacyCategories: [],
  };
}

async function setupConnection(marker: string) {
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
      accessTokenEnc: encryptToken("access-sandbox-test"),
      status: "pending",
    })
    .returning();
  await db
    .insert(accounts)
    .values({
      connectionId: conn!.id,
      plaidAccountId: "plaid-acct-sync-test",
      name: "Chequing",
      type: "depository",
    })
    .returning();
  return { userId: user!.id, connectionId: conn!.id };
}

async function txnCount(connectionId: string): Promise<number> {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { accounts, transactions } = await import("@/db/schema");
  const [acct] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId));
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.accountId, acct!.id));
  return rows.length;
}

async function getCursor(connectionId: string): Promise<string | null> {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { connections } = await import("@/db/schema");
  const [row] = await db
    .select({ cursor: connections.cursor, status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row!.cursor;
}

async function cleanup(userId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/db/client");
  const { users } = await import("@/db/schema");
  await db.delete(users).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("sync engine (live DB, mocked Plaid)", () => {
  it("backfills pages, is idempotent on re-run, and advances the cursor", async () => {
    const { syncConnection } = await import("@/modules/connections/sync");
    const { userId, connectionId } = await setupConnection(`sync-a-${Date.now()}`);

    const pages: Record<string, SyncPage> = {
      START: {
        added: [makeTxn("t1", 15.99), makeTxn("t2", 9.99)],
        modified: [],
        removed: [],
        nextCursor: "c1",
        hasMore: true,
      },
      c1: {
        added: [makeTxn("t3", 22.5)],
        modified: [],
        removed: [],
        nextCursor: "c2",
        hasMore: false,
      },
      c2: { added: [], modified: [], removed: [], nextCursor: "c2", hasMore: false },
    };
    const fetcher = async (_token: string, cursor: string | null) => pages[cursor ?? "START"]!;

    const first = await syncConnection(connectionId, fetcher);
    expect(first.status).toBe("completed");
    expect(await txnCount(connectionId)).toBe(3);
    expect(await getCursor(connectionId)).toBe("c2");

    // Re-run: resumes from c2, which returns nothing — zero new rows.
    const second = await syncConnection(connectionId, fetcher);
    expect(second.status).toBe("completed");
    expect(await txnCount(connectionId)).toBe(3);

    await cleanup(userId);
  });

  it("resumes from the last committed cursor after a mid-backfill crash", async () => {
    const { syncConnection } = await import("@/modules/connections/sync");
    const { userId, connectionId } = await setupConnection(`sync-b-${Date.now()}`);

    const page1: SyncPage = {
      added: [makeTxn("u1", 5), makeTxn("u2", 6)],
      modified: [],
      removed: [],
      nextCursor: "k1",
      hasMore: true,
    };
    const page2: SyncPage = {
      added: [makeTxn("u3", 7), makeTxn("u4", 8)],
      modified: [],
      removed: [],
      nextCursor: "k2",
      hasMore: false,
    };
    const empty: SyncPage = {
      added: [],
      modified: [],
      removed: [],
      nextCursor: "k2",
      hasMore: false,
    };

    // First attempt dies fetching the second page — like a killed worker.
    const crashing = async (_t: string, cursor: string | null): Promise<SyncPage> => {
      if (cursor === null) return page1;
      throw new Error("worker killed");
    };
    await expect(syncConnection(connectionId, crashing)).rejects.toThrow("worker killed");

    // Page 1 must be fully committed with its cursor — nothing lost, nothing torn.
    expect(await txnCount(connectionId)).toBe(2);
    expect(await getCursor(connectionId)).toBe("k1");

    // Restart resumes from k1: no gaps, no duplicates.
    const healthy = async (_t: string, cursor: string | null): Promise<SyncPage> => {
      if (cursor === null) return page1;
      if (cursor === "k1") return page2;
      return empty;
    };
    const result = await syncConnection(connectionId, healthy);
    expect(result.status).toBe("completed");
    expect(await txnCount(connectionId)).toBe(4);
    expect(await getCursor(connectionId)).toBe("k2");

    // And running the whole thing again changes nothing.
    await syncConnection(connectionId, healthy);
    expect(await txnCount(connectionId)).toBe(4);

    await cleanup(userId);
  });

  it("handles Plaid's removed ids and modified amounts via upsert", async () => {
    const { syncConnection } = await import("@/modules/connections/sync");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { transactions } = await import("@/db/schema");
    const { userId, connectionId } = await setupConnection(`sync-c-${Date.now()}`);

    const fetcher1 = async (): Promise<SyncPage> => ({
      added: [makeTxn("m1", 10), makeTxn("m2", 20)],
      modified: [],
      removed: [],
      nextCursor: "x1",
      hasMore: false,
    });
    await syncConnection(connectionId, fetcher1);

    const fetcher2 = async (_t: string, cursor: string | null): Promise<SyncPage> =>
      cursor === "x1"
        ? {
            added: [],
            modified: [{ ...makeTxn("m1", 12.5) }],
            removed: ["m2"],
            nextCursor: "x2",
            hasMore: false,
          }
        : { added: [], modified: [], removed: [], nextCursor: "x2", hasMore: false };
    await syncConnection(connectionId, fetcher2);

    expect(await txnCount(connectionId)).toBe(1);
    const [m1] = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.plaidTransactionId, "m1"));
    expect(m1!.amount).toBe("12.50");

    await cleanup(userId);
  });

  it("aborts silently for a revoking connection", async () => {
    const { syncConnection } = await import("@/modules/connections/sync");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections } = await import("@/db/schema");
    const { userId, connectionId } = await setupConnection(`sync-d-${Date.now()}`);

    await db
      .update(connections)
      .set({ status: "revoking" })
      .where(eq(connections.id, connectionId));
    const result = await syncConnection(connectionId, async () => {
      throw new Error("should never fetch");
    });
    expect(result).toEqual({ status: "aborted", reason: "revoking" });
    expect(await txnCount(connectionId)).toBe(0);

    await cleanup(userId);
  });

  it("marks the connection reauth_required on ITEM_LOGIN_REQUIRED", async () => {
    const { syncConnection } = await import("@/modules/connections/sync");
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections } = await import("@/db/schema");
    const { userId, connectionId } = await setupConnection(`sync-e-${Date.now()}`);

    const plaidError = Object.assign(new Error("login required"), {
      response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } },
    });
    const result = await syncConnection(connectionId, async () => {
      throw plaidError;
    });
    expect(result).toEqual({ status: "reauth_required" });

    const [row] = await db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connectionId));
    expect(row!.status).toBe("reauth_required");

    await cleanup(userId);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
