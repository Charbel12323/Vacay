# Progress log

## Stage 5 — Detection engine (2026-07-07)

**Built:**
`modules/detection/engine/`: a pure, deterministic TypeScript module (normalize + alias matching, stream grouping with ±15% amount clustering, cadence detection per the stage's bucket table with one-missed-charge tolerance and same-day-of-month vs every-N-days discrimination, weighted-rule classification into subscription/bill/habit with confidence, persistent price-step detection, single-charge probable annuals capped at 0.75, and `runEngine` composing it all with event candidates).
An ESLint no-restricted-imports rule scoped to `engine/` fails the build on any DB/Plaid/Redis/Node-I/O import.
`today` is an engine input, so the engine contains no clock and is fully deterministic.
Merchant seed: ~200 Canada-relevant subscription merchants (streaming, software, telecom, gyms, news, utilities, insurance, gaming…) with aliases, categories, and known plan prices in `src/db/seeds/merchants.json`; `npm run db:seed` upserts by name.
Migration `0002_detection` adds `subscriptions.stream_key` with a per-user unique constraint — the diff identity for idempotent upserts.
`modules/detection/orchestrator.ts`: loads the user's world, runs the engine, and persists only diffs — field-level compare before UPDATE, price changes deduped by exact step, alert rows (price_increase, renewal_upcoming) inserted unsent through the unique dedup gate, transaction→subscription links updated only when changed, dismissed/cancelled statuses and user_confirmed never overwritten, `user_confirmed=false` merchants suppressed and fed back as negative signals.
Connections flip `ok → ready` after the first detection run (replacing the Stage 4 TODO).
The write-time normalizer now delegates to the engine's canonical noise-strip.

**Verified:**
Ten-fixture suite in `fixtures/detection/` (clean monthly, missed month, 30-day drift, 2-charge annual, single-charge known annual, price increase, variable phone bill→bill, weekly coffee→habit, PayPal-intermediated→Netflix, two concurrent plans→two streams), each with asserted outputs.
Property test: shuffled inputs produce deep-equal outputs.
Invariant 5 test: no stream under 0.80 confidence carries an asserted verdict, across all fixtures.
Live-DB orchestration test: first run persists subscription/price_change/alert/links; second run changes literally zero rows (updatedAt included); feedback=false dismisses and suppresses.
End-to-end with a Plaid custom sandbox user (deterministic history): connect → sync → detection produced netflix = monthly/subscription/healthy/0.94 and rogers = monthly/bill/no-verdict/0.79.

**Deviations / notes:**
Engine events `new_probable_subscription` and `expected_charge_missed` are computed but not persisted to `alerts` — they are not alert types in the schema (Stage 7 defines alert types); only price_increase and renewal_upcoming are persisted, unsent.
The default sandbox institution only prepares ~30 days of history without webhooks, so the deterministic e2e uses Plaid's custom sandbox user.

## Stage 4 — Ingestion pipeline (2026-07-07)

**Built:**
`modules/connections/sync.ts`: cursor-based `/transactions/sync` loop where each page's upserts, removals, and cursor advance commit in ONE `db.transaction` (invariant 1), with an injectable page fetcher for tests.
Write-time normalization precursor (`normalizeMerchantBasic`) and transfer/refund flagging (`isTransfer`/`isRefund`/`isCountable`) in `modules/connections/normalize.ts`.
Worker: real sync handler (work-before-acknowledge, detection enqueued only after commit), 5-attempt exponential backoff, failed jobs kept as a dead-letter set, final failure marks the connection `degraded`, `revoking` connections abort silently.
`POST /api/webhooks/plaid`: ES256 JWT signature verified against Plaid's published key (fetched by kid, cached) and the body sha256 compared BEFORE the body is trusted; TRANSACTIONS webhooks enqueue a sync (deduped via jobId = connection id), ITEM error codes flip health to `reauth_required`.
Re-auth flow: `POST /api/connections/:id/reauth` (update-mode link token), `PATCH` to complete; dashboard banner opens Link update mode.
Manual refresh: `POST /api/connections/:id/refresh`, rate limited 1/min per connection.
Stage 3's TODO wired: `POST /api/connections` now enqueues the initial sync; UI polls and shows "Analyzing your accounts…" while syncing.

**Verified (live sandbox + tests):**
Connect → 202 → worker backfill → status `ok`; 48 transactions persisted, 48 distinct plaid ids after repeated re-syncs (zero duplicates).
Kill-mid-backfill test: crash after page 1 leaves page 1 + cursor committed together; restart resumes with no gaps and no duplicates.
Structural test asserts the cursor is only ever advanced inside the same transaction that writes its page.
Webhook signature tests with a real ES256 keypair (valid passes; wrong key, tampered body, bad alg, garbage all rejected); live endpoint returns 401 envelopes for missing/bad signatures.
Five rapid enqueues for one connection collapse to exactly one queued job (live Redis).
Refresh returns 202 then 429 within the window (live).
Transfer/refund flagging verified in units and against live sandbox data (card payments, ACH, CD deposits flagged; Uber store codes normalized away).

**Deviations / known gaps:**
Plaid cannot deliver webhooks to a local machine, so end-to-end webhook delivery (sandbox `fire_webhook`) awaits a public URL — set `PLAID_WEBHOOK_URL` when deployed (Stage 9) or tunnel locally; the verification and handling logic is fully tested at the route seam.
Sandbox's first `/transactions/sync` often returns zero rows until Plaid prepares the item; without webhooks locally, the manual refresh pulls the prepared data (this is sandbox-only behavior).

## Stage 3 — Plaid connect flow (2026-07-07)

**Built:**
`modules/connections/plaid.ts` as the single Plaid SDK entry point (link token, public-token exchange, accounts fetch, institution lookup, item removal), enforced by an ESLint no-restricted-imports rule.
`modules/connections/crypto.ts`: AES-256-GCM token encryption (`v1:iv:tag:ciphertext`), key derived from `TOKEN_ENC_KEY`, with round-trip, tamper, and fresh-IV tests.
API: `POST /api/connections/link-token` (CA+US, transactions product, 730-day history request), `POST /api/connections` (exchange, encrypt, persist connection + accounts, 202 with the contracted response shape, Stage 4 TODO hook for the sync enqueue), `GET /api/connections`, `GET /api/connections/:id` (polling endpoint), `DELETE /api/connections/:id` (mark revoking, Plaid `/item/remove`, purge rows).
Dashboard UI: react-plaid-link connect button, connections list with institution, account masks, and status labels, disconnect with confirmation.

**Verified (real Plaid Sandbox, in-browser):**
Full Link flow with RBC Royal Bank and user_good/pass_good: 12 accounts persisted and rendered with masks; `access_token_enc` in Postgres is a `v1:` envelope, not a Plaid token; cursor NULL and health pending as specified.
Disconnect removed the Item at Plaid and purged connection + accounts rows.
Server logs grepped clean of access tokens; live-DB tests cover encrypted-at-rest, summary serialization without token fields, cross-user NOT_FOUND, and malformed-id NOT_FOUND.

**Deviations from the stage doc:**
None material.
Malformed connection ids return 404 rather than a DB cast error (consistent with the 404-not-403 rule).

## Stage 2 — Authentication & accounts (2026-07-06)

**Built:**
Auth.js (next-auth v5) with a credentials provider (bcrypt password hashing, users created via `POST /api/auth/signup`) and Google OAuth (enabled only when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set; users rows created and `auth_provider_id` linked on first Google sign-in).
JWT sessions in httpOnly, sameSite=lax cookies (secure in production); nothing in localStorage.
Edge middleware protecting all pages except `/`, `/login`, `/signup`, and all `/api/*` except `/api/health`, `/api/auth/*`, `/api/webhooks/*`; unauthenticated API calls get the standard `{ error: { code, message } }` envelope with 401.
`modules/api` gained the typed error-code module (`UNAUTHENTICATED`, `NOT_FOUND`, `VALIDATION_FAILED`, `EMAIL_IN_USE`, `RATE_LIMITED`, `INTERNAL`), `withErrorHandling` wrapper, `requireUser()`, and `assertOwned()` implementing the 404-not-403 rule.
Fixed-window per-IP Redis rate limit (10/min) on all auth POST endpoints.
Pages: landing, sign in, sign up, and the authenticated dashboard shell with sign-out.
New migration `0001_auth` adds `users.password_hash`.

**Verified:**
Browser flow: sign up lands on /dashboard, sign out redirects, /dashboard redirects to /login with callbackUrl, explicit login honors it.
Unauthed protected API returns the 401 envelope; /api/health stays open.
Rate limit returns 429 with the envelope after the burst limit (live curl + Redis test).
Cross-user resource access returns NOT_FOUND (live-DB test with two users).
Server logs grepped clean of passwords/tokens; a static test forbids console calls referencing credentials.

**Deviations from the stage doc:**
Google OAuth is conditionally enabled by env so local dev and CI work without Google credentials.
The Playwright e2e suite arrives in Stage 6 per the stage index; Stage 2's sign-up/out flow was verified manually in a real browser.

## Stage 1 — Foundation (2026-07-06)

**Built:**
Next.js (App Router) + TypeScript strict skeleton with ESLint, Prettier, and module directories (`src/modules/{connections,detection,alerts,api}`, `src/worker/`) carrying README ownership stubs.
Drizzle ORM schema and first migration covering all eight tables (`users`, `connections`, `accounts`, `transactions`, `merchants`, `subscriptions`, `price_changes`, `alerts`) with the required enums, unique constraints, indexes, and `numeric(12,2)` money columns.
BullMQ queues (`sync`, `detection`, `alerts`) with a heartbeat worker entrypoint runnable via `npm run worker`.
Zod-validated env loader wired into Next.js instrumentation and the worker, so both processes refuse to boot on missing keys.
`GET /api/health` with real Postgres and Redis connectivity checks.
`docker-compose.yml` (Postgres 16 + Redis 7) and `npm run dev:all` for local development.
GitHub Actions CI: typecheck, lint, format check, migrate, test, build against Postgres/Redis service containers.
Tests: env loader validation, and a live-DB test proving duplicate `plaid_transaction_id` inserts fail.

**Deviations from the stage doc:**
The first migration file is `drizzle/0000_foundation.sql`, since drizzle-kit numbers from 0000; it is the "migration 0001" the stage doc describes.
Local Postgres is exposed on host port 5433 (not 5432) because the development machine runs a native PostgreSQL service on 5432.
The alerts dedup unique constraint uses `NULLS NOT DISTINCT` so connection-level alerts (with NULL `subscription_id`) still dedupe; plain unique semantics would treat NULLs as distinct rows.
Pinned `ioredis` to 5.10.1 (bullmq's own version) to avoid duplicate-type conflicts under strict TypeScript.

**Known gaps:**
None blocking.
CI "green on main" is verifiable once this branch's PR runs the workflow.
