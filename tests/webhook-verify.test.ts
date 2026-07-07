import { createHash } from "crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyPlaidWebhook } from "@/modules/connections/webhook-verify";

/**
 * Verifies the webhook signature logic with a real ES256 keypair playing the
 * role of Plaid's published key (injected through the key-fetcher seam).
 */
let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

const KID = "test-kid-1";
const body = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "item-abc",
});

async function signWebhookJwt(key: CryptoKey, forBody: string, kid = KID): Promise<string> {
  return new SignJWT({
    request_body_sha256: createHash("sha256").update(forBody, "utf8").digest("hex"),
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt()
    .sign(key);
}

const fetchKey = async (keyId: string) => {
  if (keyId !== KID) throw new Error("unknown kid");
  return publicJwk;
};

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  publicJwk.kid = KID;
  const other = await generateKeyPair("ES256", { extractable: true });
  otherPrivateKey = other.privateKey as CryptoKey;
});

describe("Plaid webhook verification", () => {
  it("accepts a correctly signed webhook", async () => {
    const token = await signWebhookJwt(privateKey, body);
    await expect(verifyPlaidWebhook(token, body, fetchKey)).resolves.toBeUndefined();
  });

  it("rejects a token signed with the wrong key", async () => {
    const token = await signWebhookJwt(otherPrivateKey, body);
    await expect(verifyPlaidWebhook(token, body, fetchKey)).rejects.toThrow();
  });

  it("rejects a body that does not match the signed hash", async () => {
    const token = await signWebhookJwt(privateKey, body);
    const tampered = body.replace("item-abc", "item-evil");
    await expect(verifyPlaidWebhook(token, tampered, fetchKey)).rejects.toThrow(/hash mismatch/);
  });

  it("rejects non-ES256 algorithms", async () => {
    // HS256-signed garbage and unsigned tokens both fail at the header check.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.e30.`;
    await expect(verifyPlaidWebhook(unsigned, body, fetchKey)).rejects.toThrow();
  });

  it("rejects garbage tokens", async () => {
    await expect(verifyPlaidWebhook("not-a-jwt", body, fetchKey)).rejects.toThrow();
  });
});
