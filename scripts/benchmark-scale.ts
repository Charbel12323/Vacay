import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, sql as pg } from "@/db/client";
import { users } from "@/db/schema";
import { cacheStats, invalidateUserDashboards, resetCacheStats } from "@/lib/cache";
import { runDetection } from "@/modules/detection/orchestrator";

/**
 * Stage 9 NFR evidence run. Requires the stage 6 benchmark seed (npm run
 * benchmark creates benchmark@example.test with 50k transactions) and the
 * web server running on 127.0.0.1:3000.
 *
 * Produces the numbers PROGRESS.md records:
 *   - detection duration over a 50k-transaction heavy user (NFR: <30s)
 *   - dashboard p95 with cache (NFR5: <500ms) and the cache hit ratio (>80%)
 */
const BASE = "http://127.0.0.1:3000";
const EMAIL = "benchmark@example.test";
const PASSWORD = "supersecret1";
// 50 reads x 2 endpoints stays inside the general per-user rate limit
// (120/min) that this same stage introduced — the limiter works; measure
// within its budget like a real client would.
const READS = 50;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const jar = new Map<string, string>();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
function storeCookies(res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    jar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
}

async function login(): Promise<string> {
  let res = await fetch(`${BASE}/api/auth/csrf`);
  storeCookies(res);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD }),
    redirect: "manual",
  });
  storeCookies(res);
  return cookieHeader();
}

async function main() {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  if (!user) throw new Error("run `npx tsx scripts/benchmark.ts` first to seed the heavy user");

  // --- Worker throughput: full detection over 50k transactions ------------
  const detectStart = Date.now();
  const result = await runDetection(user.id);
  const detectMs = Date.now() - detectStart;
  console.log(
    `[scale] detection over heavy user: ${detectMs}ms (${result.streams} streams) — NFR <30000ms: ${
      detectMs < 30_000 ? "PASS" : "FAIL"
    }`,
  );

  // --- Dashboard p95 + cache hit ratio -------------------------------------
  const cookie = await login();
  await invalidateUserDashboards(user.id); // start cold, measure honestly
  await resetCacheStats();

  const endpoints = ["/api/subscriptions/summary", "/api/subscriptions?status=active"];
  const samples: Record<string, number[]> = {};
  for (const path of endpoints) samples[path] = [];

  for (let i = 0; i < READS; i++) {
    for (const path of endpoints) {
      const started = performance.now();
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      if (res.status !== 200) throw new Error(`${path} returned ${res.status}`);
      await res.text();
      samples[path]!.push(performance.now() - started);
    }
  }

  for (const path of endpoints) {
    const s = samples[path]!;
    const p95 = percentile(s, 95).toFixed(1);
    console.log(
      `[scale] ${path}: p50=${percentile(s, 50).toFixed(1)}ms p95=${p95}ms (n=${s.length}) — NFR <500ms: ${
        Number(p95) < 500 ? "PASS" : "FAIL"
      }`,
    );
  }

  const stats = await cacheStats();
  console.log(
    `[scale] cache: ${stats.hits} hits / ${stats.misses} misses — ratio ${(stats.ratio * 100).toFixed(1)}% — NFR >80%: ${
      stats.ratio > 0.8 ? "PASS" : "FAIL"
    }`,
  );

  await pg.end({ timeout: 5 });
  process.exit(0);
}

main().catch((err) => {
  console.error("[scale] failed:", err);
  process.exit(1);
});
