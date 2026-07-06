import { NextResponse } from "next/server";
import { sql } from "@/db/client";
import { createRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let redisOk = false;

  try {
    await sql`select 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const redis = createRedis();
  try {
    redisOk = (await redis.ping()) === "PONG";
  } catch {
    redisOk = false;
  } finally {
    redis.disconnect();
  }

  const ok = dbOk && redisOk;
  return NextResponse.json({ ok, db: dbOk, redis: redisOk }, { status: ok ? 200 : 503 });
}
