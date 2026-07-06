# modules/detection

The pure detection engine plus its orchestration.

**Sole writer of:** `subscriptions`, `merchants`, `price_changes`.

`engine/` (added in Stage 5) is a pure TypeScript module: plain data in, plain data out.
No Drizzle, Plaid, Redis, or any I/O imports inside it — ever.
All persistence lives in the orchestrator.
