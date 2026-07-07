import { NextResponse } from "next/server";
import { createLinkToken } from "@/modules/connections/plaid";
import { withErrorHandling } from "@/modules/api/errors";
import { requireUser } from "@/modules/api/require-user";

export const POST = withErrorHandling(async () => {
  const user = await requireUser();
  const linkToken = await createLinkToken(user.id);
  return NextResponse.json({ link_token: linkToken });
});
