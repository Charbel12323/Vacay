import type Redis from "ioredis";
import { createRedis } from "@/lib/redis";

declare global {
  var __subtrackerRateLimitRedis: Redis | undefined;
}

function getRedis(): Redis {
  if (!globalThis.__subtrackerRateLimitRedis) {
    globalThis.__subtrackerRateLimitRedis = createRedis();
  }
  return globalThis.__subtrackerRateLimitRedis;
}

/**
 * Fixed-window counter in Redis. Returns limited=true once `limit` calls have
 * been made for `key` within the current window.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ limited: boolean; remaining: number }> {
  const redis = getRedis();
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const bucket = `rl:${key}:${window}`;
  const count = await redis.incr(bucket);
  if (count === 1) {
    await redis.expire(bucket, windowSeconds);
  }
  return { limited: count > limit, remaining: Math.max(0, limit - count) };
}

/** Best-effort client IP for rate-limit keys. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
