import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";
import { createConnection, listConnections } from "@/modules/connections/service";

const createSchema = z.object({
  public_token: z.string().min(1),
});

// 202: the response promises async completion — the initial transaction sync
// is fulfilled by Stage 4. Keep this shape; the frontend polling depends on it.
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "public_token is required");
  }

  const created = await createConnection(user.id, parsed.data.public_token);
  return NextResponse.json(
    {
      connection: {
        id: created.id,
        institution: created.institution,
        status: "syncing",
        accounts_discovered: created.accountsDiscovered,
      },
    },
    { status: 202 },
  );
});

export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  return NextResponse.json({ connections: await listConnections(user.id) });
});
