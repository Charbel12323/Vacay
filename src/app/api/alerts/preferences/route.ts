import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";
import {
  CONFIGURABLE_TYPES,
  getEffectivePreferences,
  setPreference,
} from "@/modules/alerts/preferences";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  return NextResponse.json({ preferences: await getEffectivePreferences(user.id) });
});

// reauth_required is deliberately not in the enum: transactional connection
// alerts cannot be turned off (stage 7 task 7).
const patchSchema = z
  .object({
    type: z.enum(CONFIGURABLE_TYPES as [string, ...string[]]),
    email_enabled: z.boolean(),
  })
  .strict();

export const PATCH = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Body must be { type, email_enabled } for a configurable alert type.",
    );
  }

  await setPreference(
    user.id,
    parsed.data.type as (typeof CONFIGURABLE_TYPES)[number],
    parsed.data.email_enabled,
  );

  // Read back after commit (invariant 8 — the response reflects the write).
  return NextResponse.json({ preferences: await getEffectivePreferences(user.id) });
});
