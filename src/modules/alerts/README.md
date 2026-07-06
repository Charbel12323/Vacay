# modules/alerts

Alert creation and email dispatch.

**Sole writer of:** `alerts`.

Alert creation is idempotent: gated by the unique index on
`alerts(subscription_id, type, dedup_key)`. Email is only enqueued after the
insert succeeds.
