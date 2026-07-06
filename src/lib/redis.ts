import Redis from "ioredis";
import { env } from "@/lib/env";

/**
 * New Redis connection. BullMQ requires maxRetriesPerRequest: null on
 * connections it owns, so callers get a fresh client rather than a shared one.
 */
export function createRedis(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}
