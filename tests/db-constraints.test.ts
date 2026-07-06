import { afterAll, describe, expect, it } from "vitest";

/**
 * Verifies the plaid_transaction_id UNIQUE constraint against a real database
 * (Stage 1 acceptance criterion). Requires DATABASE_URL with migrations
 * applied (docker-compose locally, service container in CI); skipped otherwise.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("database constraints", () => {
  it("rejects two transactions with the same plaid_transaction_id", async () => {
    const { db } = await import("@/db/client");
    const { accounts, connections, transactions, users } = await import("@/db/schema");

    const marker = `stage1-test-${Date.now()}`;

    const [user] = await db
      .insert(users)
      .values({ email: `${marker}@example.test` })
      .returning();
    const [connection] = await db
      .insert(connections)
      .values({
        userId: user!.id,
        plaidItemId: `item-${marker}`,
        accessTokenEnc: "test-ciphertext",
      })
      .returning();
    const [account] = await db
      .insert(accounts)
      .values({
        connectionId: connection!.id,
        plaidAccountId: `acct-${marker}`,
        name: "Test Chequing",
        type: "depository",
      })
      .returning();

    const row = {
      accountId: account!.id,
      plaidTransactionId: `txn-${marker}`,
      date: "2026-07-01",
      amount: "12.99",
      rawDescriptor: "STAGE1 TEST CHARGE",
    };

    await db.insert(transactions).values(row);
    await expect(db.insert(transactions).values(row)).rejects.toThrow(/duplicate key|unique/i);

    // Cascade from this user purges its connection, account, and transactions.
    const { eq } = await import("drizzle-orm");
    await db.delete(users).where(eq(users.id, user!.id));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
