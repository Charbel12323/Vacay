import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connections } from "@/db/schema";
import { env } from "@/lib/env";
import { createRedis } from "@/lib/redis";
import { enqueueDetection, QUEUE_NAMES } from "@/lib/queues";
import { syncConnection } from "@/modules/connections/sync";

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

// Placeholder processors; real handlers arrive with their stages.
const detectionWorker = new Worker(
  "detection",
  async (job) => {
    console.log(`[worker] detection job ${job.id} received (handler arrives in Stage 5)`);
  },
  { connection: createRedis() },
);

const alertsWorker = new Worker(
  "alerts",
  async (job) => {
    console.log(`[worker] alerts job ${job.id} received (handler arrives in Stage 7)`);
  },
  { connection: createRedis() },
);

const workers = [syncWorker, detectionWorker, alertsWorker];

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
