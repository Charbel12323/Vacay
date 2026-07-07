import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { runEngine } from "@/modules/detection/engine";
import { ASSERTED_VERDICTS } from "@/modules/detection/engine/types";
import type { EngineInput, Verdict } from "@/modules/detection/engine/types";

/**
 * The fixtures ARE the spec (stage doc). When a fixture and the code
 * disagree, the fixture is right unless it contradicts plan.md.
 */
type FixtureTransaction = {
  id: string;
  accountId?: string;
  date: string;
  amount: string;
  descriptor: string;
  pending?: boolean;
  isTransfer?: boolean;
  isRefund?: boolean;
};

type ExpectedStream = {
  normalizedMerchant: string;
  merchantName?: string;
  cadence?: string | null;
  classification?: string | null;
  verdict?: Verdict | null;
  minConfidence?: number;
  maxConfidence?: number;
  nextExpectedDate?: string;
  sameDayOfMonth?: boolean;
  currentAmount?: string;
};

type Fixture = {
  file: string;
  name: string;
  today: string;
  merchants: EngineInput["merchants"];
  priorFeedback?: EngineInput["priorFeedback"];
  transactions: FixtureTransaction[];
  expected: {
    streams: ExpectedStream[];
    priceChanges?: Array<{ oldAmount: string; newAmount: string; effectiveDate: string }>;
    priceChangeCount?: number;
    eventTypes?: string[];
  };
};

const dir = join(__dirname, "..", "fixtures", "detection");
const fixtures: Fixture[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));

function toEngineInput(fx: Fixture): EngineInput {
  return {
    today: fx.today,
    merchants: fx.merchants,
    priorFeedback: fx.priorFeedback ?? [],
    transactions: fx.transactions.map((t) => ({
      id: t.id,
      accountId: t.accountId ?? "acct-1",
      date: t.date,
      amount: t.amount,
      currency: "CAD",
      rawDescriptor: t.descriptor,
      pending: t.pending ?? false,
      isTransfer: t.isTransfer ?? false,
      isRefund: t.isRefund ?? false,
    })),
  };
}

describe("detection engine fixtures", () => {
  for (const fx of fixtures) {
    it(`${fx.file}: ${fx.name}`, () => {
      const out = runEngine(toEngineInput(fx));

      expect(out.streams, "stream count").toHaveLength(fx.expected.streams.length);
      for (const exp of fx.expected.streams) {
        const actual = out.streams.find(
          (s) =>
            s.normalizedMerchant === exp.normalizedMerchant &&
            (exp.currentAmount === undefined || s.currentAmount === exp.currentAmount),
        );
        expect(actual, `stream ${exp.normalizedMerchant} ${exp.currentAmount ?? ""}`).toBeDefined();
        if (exp.merchantName !== undefined) expect(actual!.merchantName).toBe(exp.merchantName);
        if (exp.cadence !== undefined) expect(actual!.cadence).toBe(exp.cadence);
        if (exp.classification !== undefined)
          expect(actual!.classification).toBe(exp.classification);
        if (exp.verdict !== undefined) expect(actual!.verdict).toBe(exp.verdict);
        if (exp.minConfidence !== undefined)
          expect(actual!.confidence).toBeGreaterThanOrEqual(exp.minConfidence);
        if (exp.maxConfidence !== undefined)
          expect(actual!.confidence).toBeLessThanOrEqual(exp.maxConfidence);
        if (exp.nextExpectedDate !== undefined)
          expect(actual!.nextExpectedDate).toBe(exp.nextExpectedDate);
        if (exp.sameDayOfMonth !== undefined)
          expect(actual!.sameDayOfMonth).toBe(exp.sameDayOfMonth);
      }

      if (fx.expected.priceChanges) {
        expect(
          out.priceChanges.map((p) => ({
            oldAmount: p.oldAmount,
            newAmount: p.newAmount,
            effectiveDate: p.effectiveDate,
          })),
        ).toEqual(fx.expected.priceChanges);
      }
      if (fx.expected.priceChangeCount !== undefined) {
        expect(out.priceChanges).toHaveLength(fx.expected.priceChangeCount);
      }
      if (fx.expected.eventTypes) {
        expect(out.events.map((e) => e.type).sort()).toEqual([...fx.expected.eventTypes].sort());
      }
    });
  }

  it("invariant 5: no stream below 0.80 confidence carries an asserted verdict", () => {
    for (const fx of fixtures) {
      for (const stream of runEngine(toEngineInput(fx)).streams) {
        if (stream.verdict && ASSERTED_VERDICTS.includes(stream.verdict)) {
          expect(
            stream.confidence,
            `${fx.file} ${stream.key} asserts ${stream.verdict}`,
          ).toBeGreaterThanOrEqual(0.8);
        }
      }
    }
  });

  it("is deterministic: shuffled input produces deep-equal output (property)", () => {
    // Deterministic LCG so the shuffles themselves are reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    for (const fx of fixtures) {
      const base = runEngine(toEngineInput(fx));
      for (let round = 0; round < 3; round++) {
        const input = toEngineInput(fx);
        for (let i = input.transactions.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [input.transactions[i], input.transactions[j]] = [
            input.transactions[j]!,
            input.transactions[i]!,
          ];
        }
        expect(runEngine(input)).toEqual(base);
      }
    }
  });
});
