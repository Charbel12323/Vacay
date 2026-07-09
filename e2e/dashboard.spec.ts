import { expect, test } from "@playwright/test";

/**
 * Stage 6 acceptance e2e: sandbox connect → wait ready → dashboard shows
 * detected subscriptions → reject one → gone (and stays gone on refresh).
 *
 * Uses Plaid's custom sandbox user (deterministic transaction history) via
 * /sandbox/public_token/create, so Link's iframe UI is not involved — the
 * public token is posted to the app's own /api/connections exactly the way
 * the Link onSuccess callback does.
 */

const PLAID_SANDBOX = "https://sandbox.plaid.com";
const PASSWORD = "stage6-e2e-password";

/** The most recent `count` monthly charge dates on the 15th, all in the past. */
function monthlyDates(count: number): string[] {
  const now = new Date();
  const dates: string[] = [];
  // If the 15th of this month hasn't safely passed yet, start last month.
  const year = now.getFullYear();
  const month = now.getMonth() - (now.getDate() > 17 ? 0 : 1);
  for (let i = 0; i < count; i++) {
    const d = new Date(year, month - i, 15);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-15`);
  }
  return dates;
}

function recurringCharges(description: string, amount: number, months: number) {
  return monthlyDates(months).map((date) => ({
    date_transacted: date,
    date_posted: date,
    currency: "USD",
    amount,
    description,
  }));
}

test("connect a sandbox bank, see verdicts, reject one stream", async ({ page, request }) => {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  expect(clientId, "PLAID_CLIENT_ID must be set (see .env.example)").toBeTruthy();
  expect(secret, "PLAID_SECRET must be set (see .env.example)").toBeTruthy();

  // -- Arrange: a Plaid custom sandbox user with two clean monthly streams.
  const sandboxUser = {
    seed: "subtracker-stage6-e2e",
    override_accounts: [
      {
        type: "depository",
        subtype: "checking",
        transactions: [
          ...recurringCharges("NETFLIX.COM", 18.99, 8),
          ...recurringCharges("SPOTIFY.COM", 11.99, 8),
        ],
      },
    ],
  };
  // Without an explicit range, /sandbox/public_token/create only prepares
  // ~90 days of history (the app's real Link token asks for 730 days).
  const chargeDates = monthlyDates(8);
  const tokenRes = await request.post(`${PLAID_SANDBOX}/sandbox/public_token/create`, {
    data: {
      client_id: clientId,
      secret,
      institution_id: "ins_109508",
      initial_products: ["transactions"],
      options: {
        override_username: "user_custom",
        override_password: JSON.stringify(sandboxUser),
        transactions: {
          start_date: chargeDates[chargeDates.length - 1],
          end_date: new Date().toISOString().slice(0, 10),
        },
      },
    },
  });
  expect(tokenRes.ok(), await tokenRes.text()).toBe(true);
  const { public_token } = await tokenRes.json();

  // -- Sign up a fresh user and land on the dashboard's empty state.
  const email = `stage6-e2e-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password (8+ characters)").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByText("No banks connected yet")).toBeVisible();

  // -- Connect: post the public token through the app API (Link's onSuccess
  //    path), sharing the signed-in browser session's cookies.
  const connectRes = await page.request.post("/api/connections", {
    data: { public_token },
  });
  expect(connectRes.status(), await connectRes.text()).toBe(202);

  // -- Wait for backfill + first detection run: connection flips to `ready`.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/connections");
        if (!res.ok()) return `http ${res.status()}`;
        const body = await res.json();
        return body.connections[0]?.status ?? "missing";
      },
      { timeout: 240_000, intervals: [3_000] },
    )
    .toBe("ready");

  // -- Dashboard shows both detected subscriptions as asserted verdicts.
  await page.reload();
  const rows = page.getByTestId("verdict-row");
  const netflixRow = rows.filter({ hasText: "Netflix" });
  const spotifyRow = rows.filter({ hasText: "Spotify" });
  await expect(netflixRow).toHaveCount(1);
  await expect(spotifyRow).toHaveCount(1);
  // Asserted verdicts require confidence ≥ 0.80 — these must never render
  // as question cards (invariant 5).
  await expect(page.getByTestId("question-card").filter({ hasText: "Netflix" })).toHaveCount(0);
  await expect(page.getByTestId("question-card").filter({ hasText: "Spotify" })).toHaveCount(0);

  // -- Evidence drill-down shows the charges with their raw bank descriptors.
  //    Plaid sandbox decides how much of the configured history it actually
  //    serves (≥3 recent months in practice) and enriches "SPOTIFY.COM" to
  //    "Spotify" — the drawer must show whatever the bank lines actually were.
  await spotifyRow.getByRole("button", { name: "Details" }).click();
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Charges we found" })).toBeVisible();
  const evidence = drawer.locator("code");
  await expect(evidence.first()).toHaveText("Spotify");
  expect(await evidence.count()).toBeGreaterThanOrEqual(3);

  // -- Reject: "Not a subscription" removes the stream from the list...
  await drawer.getByRole("button", { name: "Not a subscription" }).click();
  await expect(drawer).toBeHidden();
  await expect(spotifyRow).toHaveCount(0);
  await expect(netflixRow).toHaveCount(1);

  // -- ...and it stays gone after a full refresh (read-your-own-writes).
  await page.reload();
  await expect(netflixRow).toHaveCount(1);
  await expect(spotifyRow).toHaveCount(0);

  // -- Stage 8: cancellation assist. Netflix is a seeded merchant, so the
  //    sheet shows verified steps and a real deep link.
  await netflixRow.getByTestId("assist-open").click();
  const sheet = page.getByTestId("assist-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Cancel Netflix" })).toBeVisible();
  expect(await sheet.locator("li").count()).toBeGreaterThanOrEqual(2);
  await expect(sheet.getByTestId("assist-deep-link")).toHaveAttribute("href", /netflix\.com/);

  // -- Mark as cancelled: the row leaves the list and the summary's savings
  //    figure appears immediately (read-your-own-writes), surviving reload.
  await sheet.getByTestId("mark-cancelled").click();
  await expect(sheet).toBeHidden();
  await expect(netflixRow).toHaveCount(0);
  await expect(page.getByTestId("total-saved")).toContainText("18.99");

  await page.reload();
  await expect(netflixRow).toHaveCount(0);
  await expect(page.getByTestId("total-saved")).toContainText("18.99");
});
