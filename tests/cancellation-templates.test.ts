import { describe, expect, it } from "vitest";
import { cadenceLabel, renderTemplate } from "@/modules/cancellation/templates";

/**
 * Stage 8 acceptance: drafted messages render every merge field with no
 * leftover placeholders, and a missing field is an error — never a
 * "{{first_name}}" pasted into a real support chat.
 */

const fields = {
  merchant: "Streamio",
  amount: "18.99",
  cadence_label: "per month",
  first_name: "Charbel",
};

describe("message templates", () => {
  it("cancellation renders all fields, no leftovers", () => {
    const draft = renderTemplate("cancellation", fields);
    expect(draft.subject).toBe("Cancellation request — Streamio subscription");
    expect(draft.body).toContain("18.99 per month");
    expect(draft.body).toContain("Charbel");
    expect(draft.subject + draft.body).not.toMatch(/\{\{|\}\}/);
  });

  it("price match includes both prices, no leftovers", () => {
    const draft = renderTemplate("price_match", {
      ...fields,
      old_price: "16.99",
      new_price: "18.99",
    });
    expect(draft.body).toContain("16.99");
    expect(draft.body).toContain("18.99");
    expect(draft.subject + draft.body).not.toMatch(/\{\{|\}\}/);
  });

  it("a missing merge field throws instead of leaking a placeholder", () => {
    expect(() => renderTemplate("price_match", fields)).toThrow(/old_price/);
    expect(() => renderTemplate("cancellation", { ...fields, first_name: "" })).toThrow(
      /first_name/,
    );
  });

  it("tone stays firm-polite — no accusatory or begging language", () => {
    const drafts = [
      renderTemplate("cancellation", fields),
      renderTemplate("price_match", { ...fields, old_price: "16.99", new_price: "18.99" }),
    ];
    for (const d of drafts) {
      expect(d.body).not.toMatch(/scam|outrageous|please please|demand/i);
    }
  });

  it("cadence labels cover every cadence with a safe fallback", () => {
    expect(cadenceLabel("monthly")).toBe("per month");
    expect(cadenceLabel("annual")).toBe("per year");
    expect(cadenceLabel(null)).toBe("per billing period");
    expect(cadenceLabel("something-new")).toBe("per billing period");
  });
});
