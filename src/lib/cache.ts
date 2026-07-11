import type Redis from "ioredis";
import { createRedis } from "@/lib/redis";

/**
 * Cache-aside for dashboard reads (Stage 9 task 1).
 *
 * Keys: dash:{userId}:summary and dash:{userId}:subs:{filterHash}.
 * TTL 10 minutes ± 2 minutes of random jitter so a deploy-time stampede
 * doesn't make every key expire in the same second. Writers NEVER overwrite
 * cached values — they delete the user's keys and let the next read rebuild
 * (invariant 8: a PATCH deletes before its response is sent). There is no
 * full-cache flush anywhere, by design.
 *
 * The cache is an optimization, never a dependency: every operation swallows
 * Redis errors and falls back to the database.
 */

const TTL_BASE_SECONDS = 600;
const TTL_JITTER_SECONDS = 120;

let client: Redis | null = null;

function redis(): Redis {
  if (!client) client = createRedis();
  return client;
}

export function summaryKey(userId: string): string {
  return `dash:${userId}:summary`;
}

export function subsKey(userId: string, filterHash: string): string {
  return `dash:${userId}:subs:${filterHash}`;
}

/** Stable hash for list filters — same filters, same key. */
export function filterHash(params: Record<string, string | undefined>): string {
  const canonical = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  // FNV-1a: tiny, stable, good enough for cache key dispersion.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const value = await redis().get(key);
    await redis()
      .incr(value === null ? "cache:misses" : "cache:hits")
      .catch(() => {});
    return value;
  } catch {
    return null; // cache down = cache miss, never an error
  }
}

export async function cacheSet(key: string, value: string): Promise<void> {
  const jitter = Math.round((Math.random() * 2 - 1) * TTL_JITTER_SECONDS);
  try {
    await redis().setex(key, TTL_BASE_SECONDS + jitter, value);
  } catch {
    // Losing a cache write costs one rebuild; nothing to do.
  }
}

/**
 * Drop every dashboard key for one user (summary + all list variants).
 * SCAN, not KEYS — never block Redis on a wildcard.
 */
export async function invalidateUserDashboards(userId: string): Promise<void> {
  try {
    const pattern = `dash:${userId}:*`;
    let cursor = "0";
    do {
      const [next, keys] = await redis().scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) await redis().del(...keys);
    } while (cursor !== "0");
  } catch {
    // Invalidation failure must not fail the write; TTL is the backstop.
  }
}

/** Hit/miss counters for the NFR benchmark (cache hit ratio >80%). */
export async function cacheStats(): Promise<{ hits: number; misses: number; ratio: number }> {
  const [hits, misses] = await Promise.all([
    redis().get("cache:hits"),
    redis().get("cache:misses"),
  ]);
  const h = Number(hits ?? 0);
  const m = Number(misses ?? 0);
  return { hits: h, misses: m, ratio: h + m === 0 ? 0 : h / (h + m) };
}

export async function resetCacheStats(): Promise<void> {
  await redis().del("cache:hits", "cache:misses");
}
