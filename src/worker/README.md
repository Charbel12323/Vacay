# worker

Long-running process consuming BullMQ jobs (`sync`, `detection`, `alerts` queues).

All Plaid calls and all detection runs happen here — never in the web process.
Job handlers complete their work (and its DB writes) before marking the job
complete (plan.md invariant 3).

Run with `npm run worker` (or `npm run worker:dev` for watch mode).
