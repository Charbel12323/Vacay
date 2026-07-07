import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connections } from "@/db/schema";
import { enqueueSync } from "@/lib/queues";
import { errorBody } from "@/modules/api/errors";
import { verifyPlaidWebhook } from "@/modules/connections/webhook-verify";

/**
 * Plaid webhook receiver. Exempt from user auth (middleware), NOT from
 * verification: the signature is checked BEFORE the body is parsed or
 * trusted. Does the minimum — enqueue or flip health — and returns fast.
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("plaid-verification");
  const rawBody = await req.text();

  if (!token) {
    return NextResponse.json(errorBody("UNAUTHENTICATED", "Missing signature."), { status: 401 });
  }
  try {
    await verifyPlaidWebhook(token, rawBody);
  } catch {
    return NextResponse.json(errorBody("UNAUTHENTICATED", "Invalid signature."), { status: 401 });
  }

  let webhookType: string | undefined;
  let webhookCode: string | undefined;
  let itemId: string | undefined;
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    webhookType = typeof body.webhook_type === "string" ? body.webhook_type : undefined;
    webhookCode = typeof body.webhook_code === "string" ? body.webhook_code : undefined;
    itemId = typeof body.item_id === "string" ? body.item_id : undefined;
  } catch {
    return NextResponse.json(errorBody("VALIDATION_FAILED", "Malformed body."), { status: 422 });
  }

  if (!itemId) return NextResponse.json({ received: true });

  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.plaidItemId, itemId));
  if (!connection) return NextResponse.json({ received: true });

  if (webhookType === "TRANSACTIONS") {
    await enqueueSync(connection.id);
  } else if (
    webhookType === "ITEM" &&
    (webhookCode === "ERROR" ||
      webhookCode === "LOGIN_REQUIRED" ||
      webhookCode === "PENDING_EXPIRATION")
  ) {
    await db
      .update(connections)
      .set({ status: "reauth_required", updatedAt: new Date() })
      .where(eq(connections.id, connection.id));
  }

  return NextResponse.json({ received: true });
}
