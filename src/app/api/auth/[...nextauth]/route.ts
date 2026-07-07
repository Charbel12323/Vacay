import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { errorResponse } from "@/modules/api/errors";

export const GET = handlers.GET;

// Strict per-IP limit on auth mutations (sign-in attempts, callbacks).
export async function POST(req: NextRequest) {
  const { limited } = await rateLimit(`auth:${clientIp(req)}`, 10, 60);
  if (limited) {
    return errorResponse("RATE_LIMITED", "Too many attempts. Try again in a minute.");
  }
  return handlers.POST(req);
}
