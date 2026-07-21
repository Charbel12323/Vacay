import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connections } from "@/db/schema";
import { env } from "@/lib/env";
import { subsystem } from "@/lib/logger";
import { createRedis } from "@/lib/redis";
import { enqueueDetection, getQueues, QUEUE_NAMES, registerDailyScans } from "@/lib/queues";
import { purgeUser } from "@/modules/account/purge";
import { dispatchAlert, markSendFailed } from "@/modules/alerts/dispatch";
import { runDailyScans } from "@/modules/alerts/scans";
import { syncConnection } from "@/modules/connections/sync";
import { runDetection } from "@/modules/detection/orchestrator";

// Validate env before anything connects; refuses to boot on missing keys.
env();

const log = subsystem("worker");

/** Wraps a handler with a duration metric (Stage 9 observability). */
function timed<T>(metric: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  return fn().finally(() => {
    log.info({ metric, duration_ms: Date.now() - started });
  });
}

/**
 * Sync handler. Work-before-acknowledge (invariant 3): the job completes only
 * after syncConnection has committed everything; a crash means redelivery,
 * which is safe because ingestion is idempotent (invariant 4).
 */
async function handleSync(job: Job<{ connectionId: string }>): Promise<void> {
  const { connectionId } = job.data;
  const result = await timed("sync_duration", () => syncConnection(connectionId));
  log.info({ job: "sync", connectionId, result });

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
    const result = await timed("detection_duration", () =>
      runDetection(job.data.userId, { accountIds: job.data.accountIds }),
    );
    log.info({ job: "detection", userId: job.data.userId, result });
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
      const result = await timed("daily_scans_duration", () => runDailyScans());
      log.info({ job: "daily-scans", result });
      return;
    }
    const outcome = await dispatchAlert(job.data.alertId!);
    log.info({ job: "dispatch", alertId: job.data.alertId, outcome });
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
      log.error({
        job: "dispatch",
        alertId: job.data.alertId,
        error: err.message,
        msg: "marked send_failed",
      }),
    );
  }
});

/**
 * Maintenance queue: account purges (FR15). Work-before-acknowledge; every
 * purge step is idempotent, so redelivery after a crash resumes cleanly.
 */
const maintenanceWorker = new Worker<{ userId: string }>(
  "maintenance",
  async (job) => {
    if (job.name === "purge-user") {
      const result = await purgeUser(job.data.userId);
      log.info({ job: "purge-user", userId: job.data.userId, result });
    }
  },
  { connection: createRedis() },
);

const workers = [syncWorker, detectionWorker, alertsWorker, maintenanceWorker];

// Idempotent upsert of the daily scan schedule (11:00 UTC).
void registerDailyScans().catch((err) =>
  log.error({ msg: "failed to register daily scans", error: err.message }),
);

syncWorker.on("failed", (job, err) => {
  log.error({
    job: "sync",
    jobId: job?.id,
    attempt: job?.attemptsMade,
    error: err.message,
  });
  // Dead-letter: after the final attempt the job stays in the failed set and
  // the connection is marked degraded.
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void db
      .update(connections)
      .set({ status: "degraded", updatedAt: new Date() })
      .where(eq(connections.id, job.data.connectionId))
      .then(() =>
        log.error({ connectionId: job.data.connectionId, msg: "connection marked degraded" }),
      );
  }
});

for (const worker of workers) {
  if (worker !== syncWorker) {
    worker.on("failed", (job, err) => {
      log.error({ queue: worker.name, jobId: job?.id, error: err.message });
    });
  }
}

// Heartbeat with queue depths — the "is anything backing up" metric.
const heartbeat = setInterval(() => {
  void (async () => {
    const queues = getQueues();
    const depths: Record<string, number> = {};
    for (const name of QUEUE_NAMES) {
      depths[name] = await queues[name].count().catch(() => -1);
    }
    log.info({ metric: "queue_depth", depths });
  })();
}, 30_000);

log.info({ msg: "worker started", queues: QUEUE_NAMES });

/**
 * Graceful shutdown (Stage 9 task 5): Worker.close() without force waits for
 * the ACTIVE job to finish before resolving, so a deploy never kills work
 * mid-transaction. A job that outlives the platform's kill grace period is
 * redelivered — and every handler is idempotent, so that is safe too.
 */
async function shutdown(signal: string) {
  log.info({ msg: "shutdown requested, finishing in-flight jobs", signal });
  clearInterval(heartbeat);
  await Promise.all(workers.map((w) => w.close()));
  log.info({ msg: "all queues drained, exiting" });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
