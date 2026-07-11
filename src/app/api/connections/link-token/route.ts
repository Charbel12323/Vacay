import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { createLinkToken } from "@/modules/connections/plaid";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

// Link tokens hit Plaid and cost quota — strict per-IP limit (Stage 9 task 6),
// on top of the general per-user budget in requireUser.
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const { limited } = await rateLimit(`link:${clientIp(req)}`, 10, 60);
  if (limited) {
    throw new ApiError("RATE_LIMITED", "Too many connection attempts. Give it a minute.");
  }
  const linkToken = await createLinkToken(user.id);
  return NextResponse.json({ link_token: linkToken });
});
