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
