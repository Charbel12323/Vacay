import { NextResponse } from "next/server";
import { eq, max } from "drizzle-orm";
import { db } from "@/db/client";
import { connections, subscriptions } from "@/db/schema";
import { computeSummary, type SummaryStream } from "@/lib/summary";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

// Precomputed reads only (invariant 6): straight from Postgres, no Plaid, no
// detection. Redis cache-aside arrives in Stage 9.
export const GET = withErrorHandling(async () => {
  const user = await requireUser();

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
  return NextResponse.json({
    ...summary,
    as_of: freshness?.asOf?.toISOString() ?? null,
  });
});
