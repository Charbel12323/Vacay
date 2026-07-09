import { defineConfig } from "@playwright/test";

// The e2e suite needs the full stack: Postgres + Redis (docker compose),
// the web app, and the worker. The web server is started (or reused) below;
// the worker is spawned by e2e/global-setup.ts.
process.loadEnvFile(".env");

export default defineConfig({
  testDir: "e2e",
  // Sandbox backfill + detection can take a while (worker retries with
  // 30s exponential backoff if Plaid's custom user isn't ready yet).
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // One user journey, one worker: the test mutates its own user's data only,
  // but there is no point parallelizing a single spec.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    // 127.0.0.1, not localhost: other local apps sometimes hold [::1]:3000.
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
