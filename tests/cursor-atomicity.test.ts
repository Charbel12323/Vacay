import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for plan.md invariant 1: the sync cursor may only be
 * advanced inside the SAME db.transaction that writes its page. If this test
 * fails, someone split the writes — that is a data-loss bug, not a style
 * issue. Do not weaken this test to make a refactor pass.
 */
describe("cursor atomicity (code structure)", () => {
  const source = readFileSync(
    join(__dirname, "..", "src", "modules", "connections", "sync.ts"),
    "utf8",
  );

  it("advances the cursor exactly once, inside the page transaction", () => {
    const cursorWrites = source.match(/cursor: page\.nextCursor/g) ?? [];
    expect(cursorWrites).toHaveLength(1);

    const txStart = source.indexOf("db.transaction(");
    expect(txStart).toBeGreaterThan(-1);

    // Find the transaction callback's closing brace by brace matching.
    const openBrace = source.indexOf("{", source.indexOf("=>", txStart));
    let depth = 0;
    let txEnd = -1;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") depth--;
      if (depth === 0) {
        txEnd = i;
        break;
      }
    }
    expect(txEnd).toBeGreaterThan(openBrace);

    const txBody = source.slice(openBrace, txEnd);
    // The page's rows AND the cursor advance live in this one transaction.
    expect(/tx\s*\.insert\(transactions\)/.test(txBody)).toBe(true);
    expect(txBody).toContain("cursor: page.nextCursor");
    // And the cursor is written through the transaction handle, not `db`.
    expect(/tx\s*\.update\(connections\)/.test(txBody)).toBe(true);
  });

  it("has no cursor write outside a transaction handle", () => {
    // Every `.set({ cursor` in the file must be a `tx.` call, never `db.`.
    const dbCursorWrite = /db\s*\.update\(connections\)\s*\.set\(\{[^}]*cursor/s;
    expect(dbCursorWrite.test(source)).toBe(false);
  });
});
