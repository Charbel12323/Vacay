import { NextResponse } from "next/server";
import { eq, max } from "drizzle-orm";
import { db } from "@/db/client";
import { connections, subscriptions } from "@/db/schema";
import { cacheGet, cacheSet, summaryKey } from "@/lib/cache";
import { computeSummary, type SummaryStream } from "@/lib/summary";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

// Precomputed reads only (invariant 6): straight from Postgres, fronted by
// Redis cache-aside (Stage 9). Writers invalidate; reads rebuild.
export const GET = withErrorHandling(async () => {
  const user = await requireUser();

  const key = summaryKey(user.id);
  const cached = await cacheGet(key);
  if (cached) {
    return new NextResponse(cached, {
      headers: { "content-type": "application/json", "x-cache": "hit" },
    });
  }

  const rows = await db
    .select({
      status: subscriptions.status,
      classification: subscriptions.classification,
      verdict: subscriptions.verdict,
      cadence: subscriptions.cadence,
      currentAmount: subscriptions.currentAmount,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  const [freshness] = await db
    .select({ asOf: max(connections.lastSyncedAt) })
    .from(connections)
    .where(eq(connections.userId, user.id));

  const summary = computeSummary(rows as SummaryStream[]);
  const body = JSON.stringify({
    ...summary,
    as_of: freshness?.asOf?.toISOString() ?? null,
  });
  await cacheSet(key, body);
  return new NextResponse(body, {
    headers: { "content-type": "application/json", "x-cache": "miss" },
  });
});
