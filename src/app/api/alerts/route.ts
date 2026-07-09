import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { alerts, connections, merchants, subscriptions } from "@/db/schema";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { decodeCursor, encodeCursor } from "@/modules/api/pagination";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

const querySchema = z.object({
  cursor: z.string().optional(),
  unread: z.enum(["true"]).optional(),
});

/** The in-app alert feed: newest first, keyset-paginated, with unread count. */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Bad query");
  }
  const { cursor, unread } = parsed.data;

  const filters: SQL[] = [eq(alerts.userId, user.id)];
  if (unread) filters.push(eq(alerts.read, false));
  if (cursor) {
    // Anchor on the cursor row server-side: a JS ISO timestamp loses
    // Postgres microseconds, which breaks keyset filters for same-batch rows.
    const { id } = decodeCursor(cursor);
    filters.push(
      sql`(${alerts.createdAt}, ${alerts.id}) < (select a.created_at, a.id from alerts a where a.id = ${id})`,
    );
  }

  const [rows, [unreadRow]] = await Promise.all([
    db
      .select({
        id: alerts.id,
        type: alerts.type,
        payload: alerts.payload,
        read: alerts.read,
        subscription_id: alerts.subscriptionId,
        connection_id: alerts.connectionId,
        merchant: subscriptions.normalizedMerchant,
        merchantName: merchants.name,
        institution: connections.institutionName,
        created_at: alerts.createdAt,
      })
      .from(alerts)
      .leftJoin(subscriptions, eq(alerts.subscriptionId, subscriptions.id))
      .leftJoin(merchants, eq(subscriptions.merchantId, merchants.id))
      .leftJoin(connections, eq(alerts.connectionId, connections.id))
      .where(and(...filters))
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(PAGE_SIZE + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(eq(alerts.userId, user.id), eq(alerts.read, false))),
  ]);

  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor =
    rows.length > PAGE_SIZE
      ? encodeCursor(page[page.length - 1]!.created_at.toISOString(), page[page.length - 1]!.id)
      : null;

  return NextResponse.json({
    alerts: page,
    unread_count: unreadRow?.count ?? 0,
    next_cursor: nextCursor,
  });
});
