import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";
import { getConnection, removeConnection } from "@/modules/connections/service";

type Context = { params: Promise<{ id: string }> };

// The post-connect polling endpoint.
export const GET = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  return NextResponse.json({ connection: await getConnection(user.id, id) });
});

export const DELETE = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;
  await removeConnection(user.id, id);
  return NextResponse.json({ ok: true });
});
