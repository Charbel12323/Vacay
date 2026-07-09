import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connections } from "@/db/schema";
import { env } from "@/lib/env";
import { createRedis } from "@/lib/redis";
import { enqueueDetection, QUEUE_NAMES, registerDailyScans } from "@/lib/queues";
import { dispatchAlert, markSendFailed } from "@/modules/alerts/dispatch";
import { runDailyScans } from "@/modules/alerts/scans";
import { syncConnection } from "@/modules/connections/sync";
import { runDetection } from "@/modules/detection/orchestrator";

// Validate env before anything connects; refuses to boot on missing keys.
env();

/**
 * Sync handler. Work-before-acknowledge (invariant 3): the job completes only
 * after syncConnection has committed everything; a crash means redelivery,
 * which is safe because ingestion is idempotent (invariant 4).
 */
async function handleSync(job: Job<{ connectionId: string }>): Promise<void> {
  const { connectionId } = job.data;
  const result = await syncConnection(connectionId);
  console.log(`[worker] sync ${connectionId}: ${JSON.stringify(result)}`);

  if (result.status === "completed") {
    // Truth before announce (invariant 2): detection is enqueued only after
    // the sync's DB writes are committed.
    const [conn] = await db
      .select({ userId: connections.userId })
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (conn) await enqueueDetection(conn.userId);
  }
}

const syncWorker = new Worker<{ connectionId: string }>("sync", handleSync, {
  connection: createRedis(),
});

/**
 * Detection handler: runs the pure engine over the user's transactions and
 * persists the diff. Safe to re-run any time (invariant 4).
 */
const detectionWorker = new Worker<{ userId: string; accountIds?: string[] }>(
  "detection",
  async (job) => {
    const result = await runDetection(job.data.userId, { accountIds: job.data.accountIds });
    console.log(`[worker] detection ${job.data.userId}: ${JSON.stringify(result)}`);
  },
  { connection: createRedis() },
);

/**
 * Alerts queue: email dispatch jobs plus the daily scheduled scans. Dispatch
 * is work-before-acknowledge — the job completes only after the send and the
 * sent_at write; redelivery is guarded by the sent_at check inside.
 */
const alertsWorker = new Worker<{ alertId?: string }>(
  "alerts",
  async (job) => {
    if (job.name === "daily-scans") {
      const result = await runDailyScans();
      console.log(`[worker] daily scans: ${JSON.stringify(result)}`);
      return;
    }
    const outcome = await dispatchAlert(job.data.alertId!);
    console.log(`[worker] alert ${job.data.alertId}: ${outcome}`);
  },
  { connection: createRedis() },
);

alertsWorker.on("failed", (job, err) => {
  // Retries exhausted → the alert stays in-app-only, flagged send_failed.
  if (
    job?.name === "dispatch" &&
    job.data.alertId &&
    job.attemptsMade >= (job.opts.attempts ?? 1)
  ) {
    void markSendFailed(job.data.alertId).then(() =>
      console.error(`[worker] alert ${job.data.alertId} marked send_failed: ${err.message}`),
    );
  }
});

const workers = [syncWorker, detectionWorker, alertsWorker];

// Idempotent upsert of the daily scan schedule (11:00 UTC).
void registerDailyScans().catch((err) =>
  console.error(`[worker] failed to register daily scans: ${err.message}`),
);

syncWorker.on("failed", (job, err) => {
  console.error(
    `[worker] sync job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
  );
  // Dead-letter: after the final attempt the job stays in the failed set and
  // the connection is marked degraded.
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void db
      .update(connections)
      .set({ status: "degraded", updatedAt: new Date() })
      .where(eq(connections.id, job.data.connectionId))
      .then(() => console.error(`[worker] connection ${job.data.connectionId} marked degraded`));
  }
});

for (const worker of workers) {
  if (worker !== syncWorker) {
    worker.on("failed", (job, err) => {
      console.error(`[worker] ${worker.name} job ${job?.id} failed: ${err.message}`);
    });
  }
}

const heartbeat = setInterval(() => {
  console.log(`[worker] heartbeat ${new Date().toISOString()} queues=${QUEUE_NAMES.join(",")}`);
}, 30_000);

console.log(`[worker] started, listening on queues: ${QUEUE_NAMES.join(", ")}`);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  clearInterval(heartbeat);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
