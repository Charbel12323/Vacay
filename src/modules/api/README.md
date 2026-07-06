# modules/api

HTTP layer: routes, auth, validation.

**Writes:** nothing it doesn't own via other modules' interfaces.

This layer stays thin: authenticate, read precomputed data, enqueue jobs.
It never calls Plaid for data and never runs detection synchronously.
No API GET may trigger Plaid calls or detection (plan.md invariant 6).
