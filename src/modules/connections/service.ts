import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, connections } from "@/db/schema";
import { enqueueSync } from "@/lib/queues";
import { ApiError } from "@/modules/api/errors";
import { decryptToken, encryptToken } from "./crypto";
import {
  createUpdateLinkToken,
  exchangePublicToken,
  getAccounts,
  getInstitutionName,
  removeItem,
} from "./plaid";

export type ConnectionSummary = {
  id: string;
  institution: string | null;
  status: string;
  last_synced_at: string | null;
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    mask: string | null;
    currency: string;
  }>;
};

/**
 * Exchange a Plaid public token, store the encrypted access token, and
 * persist the discovered accounts. Returns what the 202 response needs.
 */
export async function createConnection(
  userId: string,
  publicToken: string,
): Promise<{ id: string; institution: string | null; accountsDiscovered: number }> {
  const { accessToken, itemId } = await exchangePublicToken(publicToken);
  const { institutionId, accounts: discovered } = await getAccounts(accessToken);
  const institutionName = institutionId ? await getInstitutionName(institutionId) : null;

  const [connection] = await db
    .insert(connections)
    .values({
      userId,
      plaidItemId: itemId,
      institutionId,
      institutionName,
      accessTokenEnc: encryptToken(accessToken),
      status: "pending",
      cursor: null,
    })
    .returning({ id: connections.id });

  if (discovered.length > 0) {
    await db.insert(accounts).values(
      discovered.map((a) => ({
        connectionId: connection!.id,
        plaidAccountId: a.plaidAccountId,
        name: a.name,
        type: a.type,
        mask: a.mask,
        currency: a.currency,
      })),
    );
  }

  // Truth before announce (invariant 2): the connection + accounts writes
  // above are committed before the sync job is enqueued.
  await enqueueSync(connection!.id);

  return {
    id: connection!.id,
    institution: institutionName,
    accountsDiscovered: discovered.length,
  };
}

export async function listConnections(userId: string): Promise<ConnectionSummary[]> {
  const rows = await db.query.connections.findMany({
    where: eq(connections.userId, userId),
    orderBy: (c, { desc }) => [desc(c.createdAt)],
  });
  const result: ConnectionSummary[] = [];
  for (const row of rows) {
    const accts = await db.query.accounts.findMany({
      where: eq(accounts.connectionId, row.id),
    });
    result.push(toSummary(row, accts));
  }
  return result;
}

export async function getConnection(userId: string, id: string): Promise<ConnectionSummary> {
  const row = await findOwnedConnection(userId, id);
  const accts = await db.query.accounts.findMany({ where: eq(accounts.connectionId, row.id) });
  return toSummary(row, accts);
}

/**
 * Disconnect: mark revoking first, remove the Item at Plaid, then purge rows.
 * If the Plaid call fails the row stays `revoking` (Stage 9's reconciliation
 * finishes the purge).
 */
export async function removeConnection(userId: string, id: string): Promise<void> {
  const row = await findOwnedConnection(userId, id);

  await db.update(connections).set({ status: "revoking" }).where(eq(connections.id, row.id));
  await removeItem(decryptToken(row.accessTokenEnc));
  await db.delete(connections).where(eq(connections.id, row.id));
}

/** Link token in update mode for a connection that needs re-auth. */
export async function createReauthToken(userId: string, id: string): Promise<string> {
  const row = await findOwnedConnection(userId, id);
  return createUpdateLinkToken(userId, decryptToken(row.accessTokenEnc));
}

/** After a successful Link update: flip health back and re-sync. */
export async function completeReauth(userId: string, id: string): Promise<void> {
  const row = await findOwnedConnection(userId, id);
  await db
    .update(connections)
    .set({ status: "syncing", updatedAt: new Date() })
    .where(eq(connections.id, row.id));
  await enqueueSync(row.id);
}

/** Manual refresh: enqueue a sync (route applies the 1/min rate limit). */
export async function requestRefresh(userId: string, id: string): Promise<void> {
  const row = await findOwnedConnection(userId, id);
  await enqueueSync(row.id);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOwnedConnection(userId: string, id: string) {
  // Malformed ids read the same as missing ones — 404, no cast errors.
  if (!UUID_RE.test(id)) throw new ApiError("NOT_FOUND", "Not found.");
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, userId)));
  if (!row) throw new ApiError("NOT_FOUND", "Not found.");
  return row;
}

function toSummary(
  row: typeof connections.$inferSelect,
  accts: Array<typeof accounts.$inferSelect>,
): ConnectionSummary {
  return {
    id: row.id,
    institution: row.institutionName,
    status: row.status,
    last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    accounts: accts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      mask: a.mask,
      currency: a.currency,
    })),
  };
}
