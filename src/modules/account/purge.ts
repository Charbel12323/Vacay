import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connections, users } from "@/db/schema";
import { invalidateUserDashboards } from "@/lib/cache";
import { decryptToken } from "@/modules/connections/crypto";
import { isItemGone, removeItem } from "@/modules/connections/plaid";

/**
 * Account deletion (FR15, plan.md invariant 9: deletion is real).
 *
 * Runs in the worker as the purge job. Order matters and every step is
 * idempotent so a crash mid-purge resumes cleanly on redelivery:
 *   1. Per connection: mark `revoking`, remove the Item at Plaid (an
 *      already-removed Item counts as success), then delete the row —
 *      accounts and transactions go with it (FK cascade).
 *   2. Delete the user row — subscriptions, price changes, alerts, and
 *      preferences cascade. Zero rows remain for this user anywhere.
 *   3. Drop the user's cached dashboard views.
 *
 * Queued alert-dispatch jobs for purged alerts find no row and no-op, so
 * emails stop the moment the rows are gone.
 */
export type RemoveItemFn = typeof removeItem;

export async function purgeUser(
  userId: string,
  removeItemFn: RemoveItemFn = removeItem,
): Promise<{ connectionsPurged: number; userDeleted: boolean }> {
  const conns = await db.select().from(connections).where(eq(connections.userId, userId));

  for (const conn of conns) {
    await db
      .update(connections)
      .set({ status: "revoking", updatedAt: new Date() })
      .where(eq(connections.id, conn.id));
    try {
      await removeItemFn(decryptToken(conn.accessTokenEnc));
    } catch (err) {
      if (!isItemGone(err)) throw err; // real failure → queue retry resumes here
    }
    await db.delete(connections).where(eq(connections.id, conn.id));
  }

  const deleted = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  await invalidateUserDashboards(userId);

  return { connectionsPurged: conns.length, userDeleted: deleted.length > 0 };
}
