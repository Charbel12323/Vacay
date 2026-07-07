import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.TOKEN_ENC_KEY ??= "test-key-0123456789abcdef0123456789";
});

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips a Plaid-shaped token", async () => {
    const { decryptToken, encryptToken } = await import("@/modules/connections/crypto");
    const token = "access-sandbox-11111111-2222-3333-4444-555555555555";
    const stored = encryptToken(token);
    expect(decryptToken(stored)).toBe(token);
  });

  it("ciphertext does not contain the plaintext and is not a Plaid token", async () => {
    const { encryptToken } = await import("@/modules/connections/crypto");
    const token = "access-sandbox-11111111-2222-3333-4444-555555555555";
    const stored = encryptToken(token);
    expect(stored).not.toContain(token);
    expect(stored).not.toMatch(/^access-/);
    expect(stored.startsWith("v1:")).toBe(true);
  });

  it("uses a fresh IV every time", async () => {
    const { encryptToken } = await import("@/modules/connections/crypto");
    expect(encryptToken("same-input")).not.toBe(encryptToken("same-input"));
  });

  it("rejects tampered ciphertext", async () => {
    const { decryptToken, encryptToken } = await import("@/modules/connections/crypto");
    const stored = encryptToken("secret-token");
    const parts = stored.split(":");
    const data = Buffer.from(parts[3]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64");
    expect(() => decryptToken(parts.join(":"))).toThrow();
  });

  it("rejects malformed stored values", async () => {
    const { decryptToken } = await import("@/modules/connections/crypto");
    expect(() => decryptToken("not-encrypted")).toThrow(/Malformed/);
    expect(() => decryptToken("v2:a:b:c")).toThrow(/Malformed/);
  });
});
