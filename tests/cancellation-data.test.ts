import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { cancellationInfoSchema } from "@/modules/cancellation/schema";

/**
 * Stage 8 acceptance: every seeded cancellation entry is schema-valid, and
 * what actually landed in the merchants table parses too. Quality gate: an
 * invalid entry must fail HERE, not render as broken guidance to a user.
 */

const fixturePath = join(__dirname, "..", "src", "db", "seeds", "cancellations.json");
const entries = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
  merchant: string;
  info: unknown;
}>;

const hasDb = Boolean(process.env.DATABASE_URL);

describe("cancellation seed fixture", () => {
  it("has a useful number of merchants and no duplicates", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    const names = entries.map((e) => e.merchant);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const entry of entries) {
    it(`${entry.merchant}: valid schema with actionable fields`, () => {
      const info = cancellationInfoSchema.parse(entry.info);
      // Every entry must be actionable: steps plus at least one contact path.
      expect(info.steps.length).toBeGreaterThanOrEqual(1);
      expect(info.url ?? info.email ?? info.phone).toBeTruthy();
      // Review provenance is mandatory.
      expect(info.sources.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe.skipIf(!hasDb)("seeded merchants table (live DB)", () => {
  it("every stored cancellation_info payload is schema-valid", async () => {
    const { isNotNull } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const { merchants } = await import("@/db/schema");

    const rows = await db
      .select({ name: merchants.name, info: merchants.cancellationInfo })
      .from(merchants)
      .where(isNotNull(merchants.cancellationInfo));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    for (const row of rows) {
      const parsed = cancellationInfoSchema.safeParse(row.info);
      expect(parsed.success, `${row.name}: ${JSON.stringify(parsed)}`).toBe(true);
    }
  });

  it("assist_opens has no user-identifying columns", async () => {
    const { sql: rawSql } = await import("drizzle-orm");
    const { db } = await import("@/db/client");
    const cols = (await db.execute(
      rawSql`select column_name from information_schema.columns where table_name = 'assist_opens'`,
    )) as unknown as Array<{ column_name: string }>;
    const names = cols.map((c) => c.column_name).sort();
    // Exact allow-list: adding ANY column here needs a privacy review.
    expect(names).toEqual(["created_at", "had_data", "id", "merchant"]);
  });

  afterAll(async () => {
    if (!hasDb) return;
    const { sql } = await import("@/db/client");
    await sql.end({ timeout: 5 });
  });
});
