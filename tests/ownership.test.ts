import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/modules/api/errors";
import { assertOwned } from "@/modules/api/ownership";

/**
 * The 404-not-403 rule: user A requesting a user-B-owned resource id gets
 * NOT_FOUND, indistinguishable from a nonexistent id.
 */
describe("assertOwned", () => {
  it("returns the row for its owner", () => {
    const row = { id: "r1", userId: "user-b" };
    expect(assertOwned(row, "user-b")).toBe(row);
  });

  it("throws NOT_FOUND for another user's resource", () => {
    const row = { id: "r1", userId: "user-b" };
    expect(() => assertOwned(row, "user-a")).toThrowError(ApiError);
    try {
      assertOwned(row, "user-a");
    } catch (err) {
      expect((err as ApiError).code).toBe("NOT_FOUND");
    }
  });

  it("throws NOT_FOUND for a missing resource", () => {
    expect(() => assertOwned(undefined, "user-a")).toThrowError(ApiError);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("cross-user resource access (live DB)", () => {
  it("user A's scoped query cannot see user B's connection", async () => {
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { connections, users } = await import("@/db/schema");

    const marker = `stage2-test-${Date.now()}`;
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
      .values({ userId: userB!.id, plaidItemId: `item-${marker}`, accessTokenEnc: "enc" })
      .returning();

    // The route pattern: filter by id AND session user id, then assertOwned.
    const [rowSeenByA] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.id, connB!.id), eq(connections.userId, userA!.id)));

    expect(rowSeenByA).toBeUndefined();
    expect(() => assertOwned(rowSeenByA, userA!.id)).toThrowError(ApiError);

    const [rowSeenByB] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.id, connB!.id), eq(connections.userId, userB!.id)));
    expect(assertOwned(rowSeenByB, userB!.id).id).toBe(connB!.id);

    await db.delete(users).where(eq(users.id, userA!.id));
    await db.delete(users).where(eq(users.id, userB!.id));
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
