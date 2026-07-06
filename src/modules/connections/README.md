# modules/connections

Plaid integration: Link, token exchange, webhook handling, cursor-based sync, transaction ingestion.

**Sole writer of:** `connections`, `accounts`, `transactions`.

No other module may write these tables.
All Plaid SDK usage in the codebase lives behind this module's client wrapper.
