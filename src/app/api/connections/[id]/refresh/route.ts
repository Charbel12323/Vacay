import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";
import { requestRefresh } from "@/modules/connections/service";

type Context = { params: Promise<{ id: string }> };

// Manual refresh, rate limited to 1/min per connection.
export const POST = withErrorHandling(async (_req: NextRequest, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;

  const { limited } = await rateLimit(`refresh:${id}`, 1, 60);
  if (limited) {
    throw new ApiError("RATE_LIMITED", "Refresh already requested. Try again in a minute.");
  }

  await requestRefresh(user.id, id);
  return NextResponse.json({ ok: true }, { status: 202 });
});
