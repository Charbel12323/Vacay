import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Stage 2 acceptance: no secret or session token appears in any log line.
 * Static check: no console.* call in src/ may reference passwords, tokens,
 * secrets, cookies, or auth headers.
 */
const FORBIDDEN =
  /console\.\w+\([^;]*\b(password|passwordHash|access_token|accessToken|secret|session[-_]?token|authorization|cookie)\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe("log hygiene", () => {
  it("no console call logs credentials, tokens, or secrets", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, "..", "src"))) {
      const content = readFileSync(file, "utf8");
      if (FORBIDDEN.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
