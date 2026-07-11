import { Queue } from "bullmq";
import { createRedis } from "@/lib/redis";

export const QUEUE_NAMES = ["sync", "detection", "alerts", "maintenance"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

let queues: Record<QueueName, Queue> | null = null;

/** Lazily created BullMQ queues sharing one Redis connection. */
export function getQueues(): Record<QueueName, Queue> {
  if (queues) return queues;
  const connection = createRedis();
  queues = {
    sync: new Queue("sync", { connection }),
    detection: new Queue("detection", { connection }),
    alerts: new Queue("alerts", { connection }),
    maintenance: new Queue("maintenance", { connection }),
  };
  return queues;
}

// Failure policy (Stage 4 task 6): exponential backoff, 5 attempts, then the
// job stays in the failed set (dead-letter) for inspection.
export const SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: false,
} as const;

/**
 * Enqueue a sync for a connection. jobId = connection id, so BullMQ dedupes
 * concurrent syncs of the same connection (duplicate webhooks collapse into
 * one job while it is queued or running).
 */
export async function enqueueSync(connectionId: string): Promise<void> {
  await getQueues().sync.add(
    "sync",
    { connectionId },
    { jobId: connectionId, ...SYNC_JOB_OPTIONS },
  );
}

/** Enqueue a detection run for a user (handler arrives in Stage 5). */
export async function enqueueDetection(userId: string): Promise<void> {
  await getQueues().detection.add(
    "detect",
    { userId },
    {
      jobId: userId,
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

/**
 * Enqueue email dispatch for one alert row. Called only AFTER the alert
 * insert committed (invariant 2 — truth before announce). jobId = alert id,
 * so a double-enqueue collapses while the job is queued or running; the
 * dispatch handler's `sent_at` check guards redelivery after that.
 */
export async function enqueueAlertDispatch(alertId: string): Promise<void> {
  await getQueues().alerts.add(
    "dispatch",
    { alertId },
    {
      jobId: alertId,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

/**
 * Enqueue the account purge (Stage 9, FR15). Called only AFTER the user is
 * marked deleted_pending. jobId dedupes double-submits; generous retries make
 * the purge resumable — every step inside is idempotent.
 */
export async function enqueuePurge(userId: string): Promise<void> {
  await getQueues().maintenance.add(
    "purge-user",
    { userId },
    {
      jobId: `purge:${userId}`,
      attempts: 10,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

/**
 * Register the daily scans as a BullMQ job scheduler (worker boot). Runs at
 * 11:00 UTC — morning across Canadian timezones. Upsert is idempotent.
 */
export async function registerDailyScans(): Promise<void> {
  await getQueues().alerts.upsertJobScheduler(
    "daily-scans",
    { pattern: "0 11 * * *" },
    { name: "daily-scans", opts: { removeOnComplete: true, removeOnFail: false } },
  );
}
