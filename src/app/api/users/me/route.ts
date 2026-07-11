import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { enqueuePurge } from "@/lib/queues";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

/**
 * Account deletion (FR15). Marks the account deleted_pending and enqueues the
 * purge — truth before announce: the status commits before the job exists.
 * The purge revokes every Plaid Item and removes every row for this user;
 * the client signs the session out on success.
 */
export const DELETE = withErrorHandling(async () => {
  const user = await requireUser();

  await db.update(users).set({ status: "deleted_pending" }).where(eq(users.id, user.id));
  await enqueuePurge(user.id);

  return NextResponse.json({ status: "deletion_scheduled" });
});
