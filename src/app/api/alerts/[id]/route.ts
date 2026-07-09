import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { alerts } from "@/db/schema";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

// Strict whitelist: marking read is the only client-writable alert field.
const patchSchema = z.object({ read: z.literal(true) }).strict();

export const PATCH = withErrorHandling(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", "Body must be exactly { read: true }.");
    }

    const updated = await db
      .update(alerts)
      .set({ read: true })
      .where(and(eq(alerts.id, id), eq(alerts.userId, user.id)))
      .returning({ id: alerts.id, read: alerts.read });
    if (updated.length === 0) {
      throw new ApiError("NOT_FOUND", "Alert not found.");
    }

    // Synchronous write committed above — the response reflects it (invariant 8).
    return NextResponse.json({ alert: updated[0] });
  },
);
