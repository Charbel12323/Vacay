import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts, connections, transactions } from "@/db/schema";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { decodeCursor, encodeCursor } from "@/modules/api/pagination";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  account_id: z.string().uuid().optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  cursor: z.string().optional(),
});

/** Raw transaction feed for evidence views. Strictly user-scoped. */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Bad query");
  }
  const { account_id, from, to, cursor } = parsed.data;

  const filters: SQL[] = [eq(connections.userId, user.id)];
  if (account_id) filters.push(eq(transactions.accountId, account_id));
  if (from) filters.push(gte(transactions.date, from));
  if (to) filters.push(lte(transactions.date, to));
  if (cursor) {
    const { sortValue, id } = decodeCursor(cursor);
    filters.push(
      or(
        lt(transactions.date, sortValue),
        and(eq(transactions.date, sortValue), lt(transactions.id, id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: transactions.id,
      account_id: transactions.accountId,
      date: transactions.date,
      amount: transactions.amount,
      currency: transactions.currency,
      raw_descriptor: transactions.rawDescriptor,
      pending: transactions.pending,
      is_transfer: transactions.isTransfer,
      is_refund: transactions.isRefund,
      subscription_id: transactions.subscriptionId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .where(and(...filters))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor =
    rows.length > PAGE_SIZE
      ? encodeCursor(page[page.length - 1]!.date, page[page.length - 1]!.id)
      : null;

  return NextResponse.json({ transactions: page, next_cursor: nextCursor });
});
