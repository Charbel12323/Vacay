import { createHash } from "crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { getWebhookVerificationKey } from "./plaid";

/**
 * Plaid webhook verification: the Plaid-Verification header is an ES256 JWT
 * whose payload carries a sha256 of the raw request body. Verify the
 * signature against Plaid's published key (fetched by kid) and compare the
 * body hash BEFORE trusting anything in the body.
 *
 * The key fetcher is injectable so tests can verify with their own ES256
 * keypair instead of live Plaid.
 */
export type KeyFetcher = (keyId: string) => Promise<Record<string, unknown>>;

const keyCache = new Map<string, Record<string, unknown>>();

async function cachedPlaidKey(keyId: string): Promise<Record<string, unknown>> {
  const hit = keyCache.get(keyId);
  if (hit) return hit;
  const key = await getWebhookVerificationKey(keyId);
  keyCache.set(keyId, key);
  return key;
}

export async function verifyPlaidWebhook(
  token: string,
  rawBody: string,
  fetchKey: KeyFetcher = cachedPlaidKey,
): Promise<void> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== "ES256" || typeof header.kid !== "string") {
    throw new Error("Unexpected webhook JWT header");
  }

  const jwk = await fetchKey(header.kid);
  const key = await importJWK(jwk as JWK, "ES256");
  const { payload } = await jwtVerify(token, key, { maxTokenAge: "5 minutes" });

  const expected = createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (payload.request_body_sha256 !== expected) {
    throw new Error("Webhook body hash mismatch");
  }
}
