import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts, merchants, subscriptions } from "@/db/schema";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { decodeCursor, encodeCursor } from "@/modules/api/pagination";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const querySchema = z.object({
  status: z.enum(["active", "dismissed", "cancelled"]).optional(),
  verdict: z
    .enum(["healthy", "price_increased", "likely_forgotten", "probable_annual", "question"])
    .optional(),
  account_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Bad query");
  }
  const { status, verdict, account_id, cursor } = parsed.data;

  const filters: SQL[] = [eq(subscriptions.userId, user.id)];
  if (status) filters.push(eq(subscriptions.status, status));
  if (verdict) filters.push(eq(subscriptions.verdict, verdict));
  if (account_id) filters.push(eq(subscriptions.accountId, account_id));
  if (cursor) {
    // Anchor on the cursor row server-side: a JS ISO timestamp loses
    // Postgres microseconds, which breaks keyset filters for rows created in
    // the same batch (e.g. one detection run inserting many streams).
    const { id } = decodeCursor(cursor);
    filters.push(
      sql`(${subscriptions.createdAt}, ${subscriptions.id}) < (select s.created_at, s.id from subscriptions s where s.id = ${id})`,
    );
  }

  const rows = await db
    .select({
      id: subscriptions.id,
      merchant: subscriptions.normalizedMerchant,
      merchantName: merchants.name,
      cadence: subscriptions.cadence,
      classification: subscriptions.classification,
      current_amount: subscriptions.currentAmount,
      currency: subscriptions.currency,
      confidence: subscriptions.confidence,
      verdict: subscriptions.verdict,
      status: subscriptions.status,
      next_expected_date: subscriptions.nextExpectedDate,
      first_charge_date: subscriptions.firstChargeDate,
      user_confirmed: subscriptions.userConfirmed,
      account_mask: accounts.mask,
      account_name: accounts.name,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .innerJoin(accounts, eq(subscriptions.accountId, accounts.id))
    .leftJoin(merchants, eq(subscriptions.merchantId, merchants.id))
    .where(and(...filters))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor =
    rows.length > PAGE_SIZE
      ? encodeCursor(page[page.length - 1]!.createdAt.toISOString(), page[page.length - 1]!.id)
      : null;

  return NextResponse.json({
    subscriptions: page.map((row) => {
      const { createdAt, ...item } = row;
      void createdAt; // cursor-only field, not part of the response shape
      return item;
    }),
    next_cursor: nextCursor,
  });
});
