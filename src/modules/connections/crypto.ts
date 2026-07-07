import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { env } from "@/lib/env";

/**
 * AES-256-GCM envelope encryption for Plaid access tokens (plan.md invariant
 * 7). Stored format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>".
 *
 * The decrypted token must never be logged or serialized into an API
 * response. Callers decrypt only at the moment a Plaid call needs it.
 */

const VERSION = "v1";
const IV_BYTES = 12;

// Accepts any >=32-char TOKEN_ENC_KEY by hashing it down to exactly 32 bytes.
function key(): Buffer {
  return createHash("sha256").update(env().TOKEN_ENC_KEY, "utf8").digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptToken(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted token");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
