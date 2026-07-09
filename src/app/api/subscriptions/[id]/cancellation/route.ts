import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildAssistPayload } from "@/modules/cancellation/assist";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const dynamic = "force-dynamic";

/**
 * Cancellation assist for one subscription. Unknown merchants get the
 * generic guidance payload — never a 404 (a user mid-cancellation must not
 * hit a dead end). 404 only when the subscription itself isn't theirs.
 */
export const GET = withErrorHandling(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    const assist = await buildAssistPayload(id, user.id);
    if (!assist) throw new ApiError("NOT_FOUND", "Subscription not found.");

    return NextResponse.json({ assist });
  },
);
