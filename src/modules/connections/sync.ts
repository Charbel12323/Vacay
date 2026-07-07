import { and, eq, gte, gt, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, connections, transactions } from "@/db/schema";
import { decryptToken } from "./crypto";
import { isRefund, isTransfer, normalizeMerchantBasic } from "./normalize";
import { isItemLoginRequired, transactionsSyncPage, type SyncPage } from "./plaid";

/**
 * Cursor-based transaction sync for one connection (plan.md invariants 1-4).
 *
 * INVARIANT 1 — CURSOR ATOMICITY: each page's transaction rows and the cursor
 * that acknowledges them commit in the SAME db.transaction call. Never split
 * these writes; a cursor ahead of its data silently loses user data forever.
 *
 * The Plaid page fetcher is injectable so tests can drive deterministic pages
 * and mid-backfill crashes without real Plaid.
 */
export type PageFetcher = (accessToken: string, cursor: string | null) => Promise<SyncPage>;

export type SyncResult =
  | { status: "completed"; pages: number; upserted: number; removed: number }
  | { status: "aborted"; reason: string }
  | { status: "reauth_required" };

export async function syncConnection(
  connectionId: string,
  fetchPage: PageFetcher = transactionsSyncPage,
): Promise<SyncResult> {
  const [connection] = await db.select().from(connections).where(eq(connections.id, connectionId));

  if (!connection) return { status: "aborted", reason: "connection not found" };
  // A revoking connection is being deleted — abort silently (Stage 4 task 6).
  if (connection.status === "revoking") return { status: "aborted", reason: "revoking" };

  await db
    .update(connections)
    .set({ status: "syncing", updatedAt: new Date() })
    .where(eq(connections.id, connectionId));

  const accountRows = await db
    .select({ id: accounts.id, plaidAccountId: accounts.plaidAccountId })
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId));
  const accountIdByPlaidId = new Map(accountRows.map((a) => [a.plaidAccountId, a.id]));

  const accessToken = decryptToken(connection.accessTokenEnc);
  let cursor: string | null = connection.cursor;
  let pages = 0;
  let upserted = 0;
  let removed = 0;

  try {
    let hasMore = true;
    while (hasMore) {
      const page = await fetchPage(accessToken, cursor);
      const rows = await buildRows(page, accountIdByPlaidId);

      // ONE transaction per page: upserts, removals, AND the cursor advance.
      await db.transaction(async (tx) => {
        for (const row of rows) {
          await tx
            .insert(transactions)
            .values(row)
            .onConflictDoUpdate({
              target: transactions.plaidTransactionId,
              set: {
                date: row.date,
                amount: row.amount,
                currency: row.currency,
                rawDescriptor: row.rawDescriptor,
                normalizedMerchant: row.normalizedMerchant,
                pending: row.pending,
                isTransfer: row.isTransfer,
                isRefund: row.isRefund,
              },
            });
        }
        if (page.removed.length > 0) {
          await tx
            .delete(transactions)
            .where(inArray(transactions.plaidTransactionId, page.removed));
        }
        await tx
          .update(connections)
          .set({ cursor: page.nextCursor, updatedAt: new Date() })
          .where(eq(connections.id, connectionId));
      });

      cursor = page.nextCursor;
      hasMore = page.hasMore;
      pages += 1;
      upserted += rows.length;
      removed += page.removed.length;
    }
  } catch (err) {
    if (isItemLoginRequired(err)) {
      await db
        .update(connections)
        .set({ status: "reauth_required", updatedAt: new Date() })
        .where(eq(connections.id, connectionId));
      return { status: "reauth_required" };
    }
    // Rethrow for the queue's retry/backoff policy. Committed pages are safe;
    // the next attempt resumes from the stored cursor.
    throw err;
  }

  // TODO(stage-05): flip to `ready` after the first detection run completes.
  await db
    .update(connections)
    .set({ status: "ok", lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(connections.id, connectionId));

  return { status: "completed", pages, upserted, removed };
}

type TransactionRow = typeof transactions.$inferInsert;

async function buildRows(
  page: SyncPage,
  accountIdByPlaidId: Map<string, string>,
): Promise<TransactionRow[]> {
  const incoming = [...page.added, ...page.modified];
  const rows: TransactionRow[] = [];
  for (const t of incoming) {
    const accountId = accountIdByPlaidId.get(t.plaidAccountId);
    if (!accountId) continue; // account not tracked (filtered at Link time)
    const normalizedMerchant = normalizeMerchantBasic(t.rawDescriptor);
    const flags = {
      amount: t.amount,
      pfcPrimary: t.pfcPrimary,
      pfcDetailed: t.pfcDetailed,
      legacyCategories: t.legacyCategories,
    };
    const refund =
      t.amount < 0 && !isTransfer(flags)
        ? isRefund(flags, await hadRecentCharge(accountId, normalizedMerchant, t.date))
        : false;
    rows.push({
      accountId,
      plaidTransactionId: t.plaidTransactionId,
      date: t.date,
      amount: t.amount.toFixed(2),
      currency: t.currency ?? "CAD",
      rawDescriptor: t.rawDescriptor,
      normalizedMerchant,
      pending: t.pending,
      isTransfer: isTransfer(flags),
      isRefund: refund,
    });
  }
  return rows;
}

/** A positive charge from the same normalized merchant in the last 90 days. */
async function hadRecentCharge(
  accountId: string,
  normalizedMerchant: string,
  date: string,
): Promise<boolean> {
  if (!normalizedMerchant) return false;
  const windowStart = new Date(date);
  windowStart.setDate(windowStart.getDate() - 90);
  const [match] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.normalizedMerchant, normalizedMerchant),
        gt(transactions.amount, "0"),
        gte(transactions.date, windowStart.toISOString().slice(0, 10)),
      ),
    )
    .limit(1);
  return Boolean(match);
}
