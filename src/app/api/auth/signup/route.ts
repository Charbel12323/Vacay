import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { env } from "@/lib/env";
import { users } from "@/db/schema";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { ApiError, withErrorHandling } from "@/modules/api/errors";

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  name: z.string().max(200).optional(),
  invite_code: z.string().max(64).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const { limited } = await rateLimit(`auth:${clientIp(req)}`, 10, 60);
  if (limited) {
    throw new ApiError("RATE_LIMITED", "Too many attempts. Try again in a minute.");
  }

  const parsed = signupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      parsed.error.issues[0]?.message ?? "Invalid signup payload",
    );
  }

  // Beta gate: enforced only when an invite code is configured, so local
  // dev and post-beta production need no code.
  const requiredInvite = env().BETA_INVITE_CODE;
  if (requiredInvite && parsed.data.invite_code !== requiredInvite) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "SubTracker is in private beta — an invite code is required.",
    );
  }

  const email = parsed.data.email.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    throw new ApiError("EMAIL_IN_USE", "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [user] = await db
    .insert(users)
    .values({ email, name: parsed.data.name, passwordHash, authProviderId: "credentials" })
    .returning({ id: users.id, email: users.email });

  return NextResponse.json({ user }, { status: 201 });
});
