import "dotenv/config";
/**
 * Stage 6 NFR benchmark: p95 < 500ms on summary + list with a heavy user
 * (50k transactions, ~60 subscriptions). Run against a PRODUCTION server:
 *   npm run build && npm run start   (in another terminal)
 *   npx tsx scripts/benchmark.ts
 * Seeds its own user (benchmark@example.test) and reuses it across runs.
 */
import { eq } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { accounts, connections, subscriptions, transactions, users } from "@/db/schema";
import { encryptToken } from "@/modules/connections/crypto";

const BASE = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = "benchmark@example.test";
const PASSWORD = "supersecret1";
const TXN_COUNT = 50_000;
const SUB_COUNT = 60;

async function ensureSeed(): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  if (existing.length > 0) {
    console.log("[bench] seed user exists, reusing");
    return;
  }
  console.log("[bench] seeding heavy user…");
  const bcrypt = await import("bcryptjs");
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 10) })
    .returning();
  const [conn] = await db
    .insert(connections)
    .values({
      userId: user!.id,
      plaidItemId: `bench-item-${user!.id}`,
      accessTokenEnc: encryptToken("bench"),
      status: "ready",
      lastSyncedAt: new Date(),
    })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({
      connectionId: conn!.id,
      plaidAccountId: `bench-acct-${user!.id}`,
      name: "Chequing",
      type: "depository",
      mask: "0000",
    })
    .returning();

  const subRows = Array.from({ length: SUB_COUNT }, (_, i) => ({
    userId: user!.id,
    streamKey: `${account!.id}:bench-merchant-${i}:0`,
    accountId: account!.id,
    normalizedMerchant: `bench merchant ${i}`,
    cadence: (["monthly", "annual", "weekly", "quarterly"] as const)[i % 4],
    classification: "subscription" as const,
    verdict: (["healthy", "price_increased", "likely_forgotten", "question"] as const)[i % 4],
    confidence: i % 4 === 3 ? "0.60" : "0.92",
    currentAmount: `${10 + (i % 30)}.99`,
    currency: "CAD",
    firstChargeDate: "2024-07-15",
    lastChargeDate: "2026-06-15",
    nextExpectedDate: "2026-07-15",
  }));
  const insertedSubs = await db.insert(subscriptions).values(subRows).returning({
    id: subscriptions.id,
  });

  const BATCH = 2_000;
  for (let offset = 0; offset < TXN_COUNT; offset += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, TXN_COUNT - offset) }, (_, j) => {
      const i = offset + j;
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String((i % 24) % 12 || 12).padStart(2, "0");
      const year = 2024 + Math.floor((i % 24) / 12);
      return {
        accountId: account!.id,
        plaidTransactionId: `bench-${user!.id}-${i}`,
        subscriptionId: i % 10 === 0 ? insertedSubs[i % SUB_COUNT]!.id : null,
        date: `${year}-${month}-${day}`,
        amount: `${5 + (i % 200)}.${String(i % 100).padStart(2, "0")}`,
        currency: "CAD",
        rawDescriptor: `BENCH MERCHANT ${i % 500}`,
      };
    });
    await db.insert(transactions).values(rows);
    process.stdout.write(`\r[bench] transactions: ${Math.min(offset + BATCH, TXN_COUNT)}`);
  }
  console.log("\n[bench] seed complete");
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

async function login(): Promise<void> {
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
  const check = await fetch(`${BASE}/api/subscriptions/summary`, {
    headers: { cookie: cookieHeader() },
  });
  if (check.status !== 200) throw new Error(`login failed: ${check.status}`);
}

async function measure(name: string, url: string, n = 100): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fetch(url, { headers: { cookie: cookieHeader() } });
    await res.text();
    times.push(performance.now() - start);
    if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status}`);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(n * 0.5)]!.toFixed(1);
  const p95 = times[Math.floor(n * 0.95)]!.toFixed(1);
  const max = times[n - 1]!.toFixed(1);
  console.log(`[bench] ${name}: p50=${p50}ms p95=${p95}ms max=${max}ms (n=${n})`);
  if (Number(p95) >= 500) {
    console.error(`[bench] FAIL: ${name} p95 ${p95}ms >= 500ms (NFR5)`);
    process.exitCode = 1;
  }
}

async function main() {
  await ensureSeed();
  await login();
  await measure("GET /api/subscriptions/summary", `${BASE}/api/subscriptions/summary`);
  await measure("GET /api/subscriptions", `${BASE}/api/subscriptions?status=active`);
  await measure("GET /api/transactions", `${BASE}/api/transactions?from=2026-01-01&to=2026-06-30`);
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("[bench] failed:", err);
  process.exit(1);
});
