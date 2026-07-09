import { describe, expect, it } from "vitest";
import { groupByVerdict, verdictLine, type SubscriptionListItem } from "@/lib/verdict-ui";

function item(overrides: Partial<SubscriptionListItem>): SubscriptionListItem {
  return {
    id: Math.random().toString(36).slice(2),
    merchant: "netflix",
    merchantName: "Netflix",
    cadence: "monthly",
    classification: "subscription",
    current_amount: "18.99",
    currency: "CAD",
    confidence: "0.92",
    verdict: "healthy",
    status: "active",
    next_expected_date: "2026-08-15",
    first_charge_date: "2026-01-15",
    user_confirmed: null,
    account_mask: "0000",
    ...overrides,
  };
}

describe("groupByVerdict (UI invariant 5)", () => {
  it("routes verdicts to their severity groups", () => {
    const groups = groupByVerdict([
      item({ verdict: "price_increased" }),
      item({ verdict: "likely_forgotten" }),
      item({ verdict: "healthy" }),
      item({ verdict: "probable_annual", confidence: "0.75" }),
      item({ verdict: "question", confidence: "0.60" }),
    ]);
    expect(groups.price_increased).toHaveLength(1);
    expect(groups.likely_forgotten).toHaveLength(1);
    expect(groups.healthy).toHaveLength(1);
    expect(groups.questions).toHaveLength(2); // probable_annual + question
  });

  it("NEVER renders a sub-0.80 stream in a verdict section, whatever its verdict says", () => {
    // Even if a bug upstream stamped an asserted verdict on a low-confidence
    // stream, the UI must still ask, not assert.
    const groups = groupByVerdict([
      item({ verdict: "healthy", confidence: "0.79" }),
      item({ verdict: "price_increased", confidence: "0.50" }),
      item({ verdict: "likely_forgotten", confidence: "0.10" }),
    ]);
    expect(groups.questions).toHaveLength(3);
    expect(groups.healthy).toHaveLength(0);
    expect(groups.price_increased).toHaveLength(0);
    expect(groups.likely_forgotten).toHaveLength(0);
  });

  it("excludes non-active and non-subscription rows entirely", () => {
    const groups = groupByVerdict([
      item({ status: "dismissed" }),
      item({ status: "cancelled" }),
      item({ classification: "bill", verdict: null }),
      item({ classification: "habit", verdict: null }),
    ]);
    expect(
      groups.healthy.length +
        groups.questions.length +
        groups.price_increased.length +
        groups.likely_forgotten.length,
    ).toBe(0);
  });
});

describe("verdict copy (calm, factual, evidence-first)", () => {
  it("describes a price increase with the actual numbers", () => {
    const line = verdictLine(item({ verdict: "price_increased" }), {
      old_amount: "16.99",
      new_amount: "18.99",
      effective_date: "2026-05-15",
    });
    expect(line).toBe("Went from $16.99 to $18.99 in May 2026");
  });

  it("describes healthy streams by their unbroken history", () => {
    expect(verdictLine(item({ verdict: "healthy" }))).toBe(
      "No charge pattern break since January 2026 — looks healthy",
    );
  });

  it("asks instead of asserting for questions", () => {
    expect(verdictLine(item({ verdict: "question" }))).toBe("Is Netflix a subscription?");
  });

  it("never uses accusatory language", () => {
    for (const verdict of ["price_increased", "likely_forgotten", "healthy", "question"]) {
      const line = verdictLine(item({ verdict }));
      expect(line.toLowerCase()).not.toMatch(/wasted|blame|fault|careless/);
    }
  });
});
