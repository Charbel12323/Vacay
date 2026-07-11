import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import { db, sql as pg } from "@/db/client";
import { merchants } from "@/db/schema";
import { cancellationInfoSchema } from "@/modules/cancellation/schema";

/**
 * Seeds the shared merchants table from the reviewed JSON fixture.
 * Idempotent: upserts by unique name. Run with `npm run db:seed`.
 */
type SeedMerchant = {
  name: string;
  aliases: string[];
  category: string;
  knownPlans: Array<{ name?: string; amount: string; cadence: string }>;
};

async function main() {
  const file = join(__dirname, "seeds", "merchants.json");
  const seed = JSON.parse(readFileSync(file, "utf8")) as SeedMerchant[];

  for (const m of seed) {
    await db
      .insert(merchants)
      .values({
        name: m.name,
        aliases: m.aliases,
        category: m.category,
        knownPlans: m.knownPlans,
      })
      .onConflictDoUpdate({
        target: merchants.name,
        set: {
          aliases: m.aliases,
          category: m.category,
          knownPlans: m.knownPlans,
        },
      });
  }

  const [{ count }] = (await db.execute(
    sql`select count(*)::int as count from merchants`,
  )) as unknown as [{ count: number }];
  console.log(`[seed] merchants seeded: ${seed.length} upserted, ${count} total`);

  // Cancellation instructions (Stage 8): zod-validated on write — a bad
  // entry aborts the seed rather than storing junk instructions.
  const cancelFile = join(__dirname, "seeds", "cancellations.json");
  const cancelSeed = JSON.parse(readFileSync(cancelFile, "utf8")) as Array<{
    merchant: string;
    info: unknown;
  }>;
  let applied = 0;
  for (const entry of cancelSeed) {
    const info = cancellationInfoSchema.parse(entry.info); // throws on invalid
    const updated = await db
      .update(merchants)
      .set({ cancellationInfo: info })
      .where(eq(merchants.name, entry.merchant))
      .returning({ id: merchants.id });
    if (updated.length === 0) {
      throw new Error(`cancellation entry for unknown merchant: ${entry.merchant}`);
    }
    applied++;
  }
  console.log(`[seed] cancellation info applied to ${applied} merchants`);
  await pg.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
