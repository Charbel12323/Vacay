import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";
import { completeReauth, createReauthToken } from "@/modules/connections/service";

type Context = { params: Promise<{ id: string }> };

/** Returns a Plaid link token in update mode for re-authentication. */
export const POST = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  const linkToken = await createReauthToken(user.id, id);
  return NextResponse.json({ link_token: linkToken });
});

/** Called after Link update mode succeeds: restore health and re-sync. */
export const PATCH = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  await completeReauth(user.id, id);
  return NextResponse.json({ ok: true });
});
