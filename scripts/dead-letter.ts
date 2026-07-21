import "dotenv/config";
import { getQueues, QUEUE_NAMES } from "@/lib/queues";

/**
 * Dead-letter review (Stage 9 task 4). Failed jobs stay in each queue's
 * failed set (removeOnFail: false) for exactly this inspection.
 *
 *   npm run queues:failed                    list failed jobs everywhere
 *   npm run queues:failed -- --retry all     retry every failed job
 *   npm run queues:failed -- --retry sync    retry one queue's failed jobs
 *
 * Retry re-runs the job through its normal handler — safe, because every
 * handler is idempotent (invariant 4).
 */
async function main() {
  const args = process.argv.slice(2);
  const retryTarget = args[0] === "--retry" ? (args[1] ?? "all") : null;

  const queues = getQueues();
  let totalFailed = 0;

  for (const name of QUEUE_NAMES) {
    const queue = queues[name];
    const failed = await queue.getFailed(0, 200);
    totalFailed += failed.length;
    if (failed.length === 0) continue;

    console.log(`\n${name}: ${failed.length} failed job(s)`);
    for (const job of failed) {
      console.log(
        `  [${job.id}] ${job.name} attempts=${job.attemptsMade} ` +
          `data=${JSON.stringify(job.data)}\n    reason: ${job.failedReason ?? "unknown"}`,
      );
      if (retryTarget === "all" || retryTarget === name) {
        await job.retry();
        console.log("    → re-enqueued");
      }
    }
  }

  if (totalFailed === 0) console.log("No failed jobs. Dead-letter set is clean.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[dead-letter] failed:", err);
  process.exit(1);
});
