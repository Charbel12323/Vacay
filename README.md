# SubTracker

Consumer fintech web app (Canada-first) that connects to bank accounts read-only via Plaid, detects recurring subscriptions, flags price increases and forgotten charges, and helps users cancel.
See `plan.md` for the full architecture and `stages/` for the build plan.

## Local development

```bash
cp .env.example .env      # fill in keys
docker compose up -d      # Postgres (host port 5433) + Redis
npm install
npm run db:migrate
npm run dev:all           # web (Next.js) + worker (BullMQ)
```

Health check: `GET http://127.0.0.1:3000/api/health`.

## Scripts

- `npm run dev:all` - web + worker together
- `npm run worker` - worker only
- `npm test` - vitest (DB tests need docker compose up + migrations applied)
- `npm run typecheck` / `npm run lint` / `npm run format:check`
- `npm run db:generate` / `npm run db:migrate` - Drizzle migrations
