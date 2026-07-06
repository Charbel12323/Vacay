import "dotenv/config";
import { Worker } from "bullmq";
import { env } from "@/lib/env";
import { createRedis } from "@/lib/redis";
import { QUEUE_NAMES } from "@/lib/queues";

// Validate env before anything connects; refuses to boot on missing keys.
env();

// Placeholder processors. Real handlers arrive with their stages:
// sync (Stage 4), detection (Stage 5), alerts (Stage 7).
const workers = QUEUE_NAMES.map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        console.log(`[worker] ${name} received job ${job.id} (no handler yet, stage pending)`);
      },
      { connection: createRedis() },
    ),
);

for (const worker of workers) {
  worker.on("failed", (job, err) => {
    console.error(`[worker] ${worker.name} job ${job?.id} failed: ${err.message}`);
  });
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
