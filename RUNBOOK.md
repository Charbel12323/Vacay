# SubTracker RUNBOOK

On-call basics, recovery procedures, and the launch checklist.
Written for the person paged at 3am: every section states symptoms first, then actions.

## Architecture in one paragraph

Web (Next.js on Vercel) serves reads from Postgres fronted by Redis cache-aside and enqueues work.
The worker (Railway) owns all Plaid calls and detection runs, consuming BullMQ queues (`sync`, `detection`, `alerts`, `maintenance`) on Redis (Upstash).
Postgres (Neon) is the single source of truth; the cursor for each Plaid connection advances only in the same transaction as its data (invariant 1).
Everything is idempotent: re-running any job is always safe.

## Incident: Plaid webhooks stop arriving

Symptoms: `last_synced_at` ages across many connections; users report stale dashboards; webhook route traffic drops to zero.

1. Check Plaid status (status.plaid.com) and the Vercel logs for `/api/webhooks/plaid` 4xx/5xx.
2. A 401/400 spike means signature verification is failing — check whether `PLAID_WEBHOOK_URL` or the Plaid webhook key changed.
3. No inbound traffic at all: confirm the webhook URL registered on link tokens matches the deployed domain.
4. Recovery needs no backfill step: the daily reconciliation sweep re-enqueues detection where transactions outpaced it, and the staleness scan flags connections quiet for 3+ days.
   For immediate recovery, enqueue syncs manually per connection or wait for users' manual Refresh.

## Incident: Plaid API outage

Symptoms: sync jobs failing across the board with Plaid 5xx; dead-letter set growing.

1. Do nothing destructive — the queue's exponential backoff (5 attempts over ~8 min) absorbs short outages.
2. Longer outages push jobs to the failed set and mark connections `degraded`.
3. After Plaid recovers: `npm run queues:failed -- --retry sync` re-runs everything; ingestion idempotency makes this safe.
4. Connections left `degraded` recover on their next successful sync; `revoking` orphans are finished by the daily sweep.

## Incident: queue backlog

Symptoms: heartbeat log line `queue_depth` climbing; alerts/syncs delayed.

1. Check the worker is alive (Railway logs; heartbeat every 30s).
2. One slow job type can starve a queue — check `queue_depth` per queue to find which.
3. Scale: Railway worker instances can be increased; all handlers are idempotent and BullMQ locks jobs, so multiple workers are safe.
4. Never delete the queues; drain by processing.

## Incident: Redis flush or cache poisoning

The cache is an optimization, never truth (invariant: reads fall back to Postgres).

1. A full Redis loss costs: cached dashboards (rebuild on demand), rate-limit counters (reset — acceptable), queued jobs (BullMQ state — this is the real loss).
2. If ONLY cache keys must go: delete by prefix `dash:` with SCAN, never FLUSHALL — the same Redis holds the queues.
3. After queue loss: run the daily scans manually (they re-derive lost work) and `npm run queues:failed` to inspect survivors.
4. Cache invalidation bugs (stale dashboards): a user PATCH must always delete `dash:{userId}:*` — verify in `src/lib/cache.ts` wiring before suspecting Redis.

## TOKEN_ENC_KEY rotation

Access tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY` (envelope format `iv:tag:ciphertext`).

1. Add `TOKEN_ENC_KEY_NEXT` with the new key; deploy code that decrypts with either key and encrypts with NEXT (small change in `modules/connections/crypto.ts` — write it at rotation time, this is deliberate).
2. Run a one-off script re-encrypting every `connections.access_token_enc` row (decrypt old → encrypt new) inside a transaction per row.
3. Verify: every connection can still sync (spot-check one manual refresh per institution).
4. Swap `TOKEN_ENC_KEY` to the new value, remove `TOKEN_ENC_KEY_NEXT`, redeploy, shred the old key.
5. Rotate immediately on: employee offboarding with prod access, any suspected leak, and at least annually.

## Postgres restore drill (Neon PITR)

Do this once before launch and quarterly after; record timings below.

1. In the Neon console create a branch from a point-in-time 10 minutes ago.
2. Point a local `.env` DATABASE_URL at the branch; run `npm test` (the live-DB suite is the smoke test) and spot-check row counts vs production.
3. To actually restore: promote the branch (or repoint `DATABASE_URL` in Vercel + Railway), then run the daily scans once to reconcile anything that happened after the restore point.
4. Record: date, restore point, minutes-to-usable, verified-by.

| Date                              | Restore point | Minutes to usable | Verified by |
| --------------------------------- | ------------- | ----------------- | ----------- |
| _pending — perform before launch_ |               |                   |             |

## Production infrastructure checklist (operator)

These need account access and are performed by a human, not the agent:

- [ ] Neon Postgres: create project, enable PITR, set `DATABASE_URL` in Vercel + Railway.
- [ ] Upstash Redis: create database (TLS URL), set `REDIS_URL` in both.
- [ ] Vercel: import repo, set all env vars from `.env.example` with production values, custom domain + HTTPS.
- [ ] Railway: worker service `npm run worker`, same env vars, autoscale 1-2 instances.
- [ ] Resend: verified sending domain, production API key (`re_…`), set `EMAIL_FROM`.
- [ ] Plaid: request Production access (Transactions product, CA + US institutions); the security questionnaire answers live in this repo — headers/CSP (next.config.ts), encryption at rest (crypto.ts), deletion (FR15 purge), logging redaction (lib/logger.ts), rate limits.
- [ ] Set `PLAID_WEBHOOK_URL` to `https://<domain>/api/webhooks/plaid` and separate sandbox/production credentials.
- [ ] Set `BETA_INVITE_CODE` for the private beta; unset it to open signup.
- [ ] `APP_BASE_URL` = production domain (email links).
- [ ] Run the restore drill (section above) and fill in the table.

## Environment promotion

Sandbox → production is a credentials swap, never a code change: `PLAID_ENV=production`, production `PLAID_SECRET`, real `RESEND_API_KEY`, real `TOKEN_ENC_KEY` (never the dev placeholder), `AUTH_SECRET` regenerated.
The env validator refuses to boot on missing keys — a failed boot after promotion means a missing var, read its error.
