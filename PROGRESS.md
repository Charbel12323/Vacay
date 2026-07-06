# Progress log

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
