import { describe, expect, it } from "vitest";
import { renderAlertEmail, type AlertEmailContext } from "@/modules/alerts/emails";

/**
 * Template acceptance: stable rendering (snapshots), dark-client support,
 * dashboard + preferences links, and no leakage — raw bank descriptors and
 * anything beyond the account mask must never appear in an email.
 */

const base: Omit<AlertEmailContext, "type" | "payload"> = {
  merchantName: "Netflix",
  amount: "18.99",
  currency: "CAD",
  cadence: "monthly",
  accountMask: "0042",
  institutionName: "First Platypus Bank",
  baseUrl: "https://app.subtracker.test",
};

const cases: Array<{ name: string; ctx: AlertEmailContext }> = [
  {
    name: "price increase",
    ctx: {
      ...base,
      type: "price_increase",
      payload: { old_amount: "16.99", new_amount: "18.99", effective_date: "2026-05-15" },
    },
  },
  {
    name: "renewal upcoming",
    ctx: {
      ...base,
      type: "renewal_upcoming",
      cadence: "annual",
      amount: "119.00",
      payload: { expected_date: "2026-08-01", cadence: "annual" },
    },
  },
  {
    name: "upcoming charge",
    ctx: {
      ...base,
      type: "upcoming_charge",
      payload: { expected_date: "2026-07-12", cadence: "monthly", amount: "18.99" },
    },
  },
  {
    name: "reauth required",
    ctx: {
      ...base,
      merchantName: null,
      amount: null,
      cadence: null,
      type: "reauth_required",
      payload: { institution_name: "First Platypus Bank", reason: "stale_sync" },
    },
  },
];

describe("alert email templates", () => {
  for (const { name, ctx } of cases) {
    it(`${name}: renders stably with links and dark-mode support`, async () => {
      const { subject, html } = await renderAlertEmail(ctx);

      expect({ subject, html }).toMatchSnapshot();

      // Dark clients get explicit overrides, not inverted defaults.
      expect(html).toContain("prefers-color-scheme: dark");
      // Every email links to the dashboard and the preferences page.
      expect(html).toContain("https://app.subtracker.test/dashboard");
      expect(html).toContain("https://app.subtracker.test/settings");
    });
  }

  it("never leaks raw descriptors or account numbers beyond the mask", async () => {
    for (const { ctx } of cases) {
      const { subject, html } = await renderAlertEmail(ctx);
      const all = subject + html;
      // The context deliberately has no raw descriptor field at all; guard
      // against one sneaking in via payload passthrough.
      expect(all).not.toMatch(/NETFLIX\.COM|raw_descriptor/i);
      // Human-visible text may show the 4-digit mask, never anything longer.
      // (Markup and hex colors excluded — only rendered text counts.)
      const visibleText = all.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
      expect(visibleText).not.toMatch(/\d{5,}/);
    }
  });

  it("subjects lead with evidence, not accusation", async () => {
    const { subject } = await renderAlertEmail(cases[0]!.ctx);
    expect(subject).toBe("Netflix went from $16.99 to $18.99");
    for (const { ctx } of cases) {
      const { subject: s, html } = await renderAlertEmail(ctx);
      expect(s + html).not.toMatch(/wasted|careless|forgot to cancel/i);
    }
  });
});
