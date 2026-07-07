import { afterAll, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("connections persistence (live DB)", () => {
  it("stores the access token encrypted at rest, and summaries never expose it", async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections, users } = await import("@/db/schema");
    const { encryptToken } = await import("@/modules/connections/crypto");
    const { getConnection } = await import("@/modules/connections/service");

    const marker = `stage3-test-${Date.now()}`;
    const plaidToken = "access-sandbox-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    const [user] = await db
      .insert(users)
      .values({ email: `${marker}@example.test` })
      .returning();
    const [conn] = await db
      .insert(connections)
      .values({
        userId: user!.id,
        plaidItemId: `item-${marker}`,
        institutionName: "Test Bank",
        accessTokenEnc: encryptToken(plaidToken),
      })
      .returning();

    // At rest: not a valid Plaid token string.
    const [raw] = await db.select().from(connections).where(eq(connections.id, conn!.id));
    expect(raw!.accessTokenEnc).not.toContain(plaidToken);
    expect(raw!.accessTokenEnc).not.toMatch(/^access-/);

    // Serialized API summary: no token field at all.
    const summary = await getConnection(user!.id, conn!.id);
    expect(JSON.stringify(summary)).not.toContain("access");
    expect(JSON.stringify(summary)).not.toContain(plaidToken);

    await db.delete(users).where(eq(users.id, user!.id));
  });

  it("another user's connection id reads as NOT_FOUND", async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections, users } = await import("@/db/schema");
    const { encryptToken } = await import("@/modules/connections/crypto");
    const { getConnection } = await import("@/modules/connections/service");
    const { ApiError } = await import("@/modules/api/errors");

    const marker = `stage3-iso-${Date.now()}`;
    const [userA] = await db
      .insert(users)
      .values({ email: `${marker}-a@example.test` })
      .returning();
    const [userB] = await db
      .insert(users)
      .values({ email: `${marker}-b@example.test` })
      .returning();
    const [connB] = await db
      .insert(connections)
      .values({
        userId: userB!.id,
        plaidItemId: `item-${marker}`,
        accessTokenEnc: encryptToken("access-sandbox-x"),
      })
      .returning();

    await expect(getConnection(userA!.id, connB!.id)).rejects.toThrowError(ApiError);
    await expect(getConnection(userA!.id, connB!.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Malformed id: also NOT_FOUND, no DB cast error.
    await expect(getConnection(userA!.id, "not-a-uuid")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await db.delete(users).where(eq(users.id, userA!.id));
    await db.delete(users).where(eq(users.id, userB!.id));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
