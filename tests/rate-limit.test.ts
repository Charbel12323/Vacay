import { afterAll, describe, expect, it } from "vitest";

const hasRedis = Boolean(process.env.REDIS_URL);

describe.skipIf(!hasRedis)("rate limiting (live Redis)", () => {
  it("allows `limit` calls then limits the rest of the window", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const key = `test-${Date.now()}-${process.pid}`;

    for (let i = 1; i <= 10; i++) {
      const { limited } = await rateLimit(key, 10, 60);
      expect(limited, `call ${i} should be allowed`).toBe(false);
    }
    const eleventh = await rateLimit(key, 10, 60);
    expect(eleventh.limited).toBe(true);
    expect(eleventh.remaining).toBe(0);
  });

  it("keys are independent", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const a = await rateLimit(`test-a-${Date.now()}`, 2, 60);
    expect(a.limited).toBe(false);
  });

  afterAll(async () => {
    if (!hasRedis) return;
    globalThis.__subtrackerRateLimitRedis?.disconnect();
  });
});

describe("clientIp", () => {
  it("takes the first x-forwarded-for entry", async () => {
    const { clientIp } = await import("@/lib/rate-limit");
    const req = new Request("http://x", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to unknown", async () => {
    const { clientIp } = await import("@/lib/rate-limit");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
