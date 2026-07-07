import { Queue } from "bullmq";
import { createRedis } from "@/lib/redis";

export const QUEUE_NAMES = ["sync", "detection", "alerts"] as const;
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
