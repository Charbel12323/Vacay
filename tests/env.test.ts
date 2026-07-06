import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env() caches its parse result per module instance, so reset modules and
// re-import to exercise the schema fresh in each test.
describe("env loader", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("throws a descriptive error when required keys are missing", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    const { env } = await import("@/lib/env");
    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it("parses a complete environment", async () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      PLAID_CLIENT_ID: "id",
      PLAID_SECRET: "secret",
      PLAID_ENV: "sandbox",
      TOKEN_ENC_KEY: "0123456789abcdef0123456789abcdef",
      RESEND_API_KEY: "re_test",
      AUTH_SECRET: "auth-secret",
    });
    const { env } = await import("@/lib/env");
    expect(env().PLAID_ENV).toBe("sandbox");
    expect(env().DATABASE_URL).toContain("postgres://");
  });
});
