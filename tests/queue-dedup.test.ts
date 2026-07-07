import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";

const hasRedis = Boolean(process.env.REDIS_URL);

/**
 * Duplicate webhooks collapse into one sync job: enqueueSync uses
 * jobId = connection id, and BullMQ ignores adds whose id already exists in
 * the waiting/delayed/active sets.
 */
describe.skipIf(!hasRedis)("sync queue dedup (live Redis)", () => {
  it("five rapid enqueues for one connection yield exactly one job", async () => {
    const { enqueueSync, getQueues } = await import("@/lib/queues");
    const connectionId = randomUUID();

    await Promise.all([
      enqueueSync(connectionId),
      enqueueSync(connectionId),
      enqueueSync(connectionId),
      enqueueSync(connectionId),
      enqueueSync(connectionId),
    ]);

    const queue = getQueues().sync;
    const jobs = await queue.getJobs(["waiting", "delayed", "paused", "active"]);
    const mine = jobs.filter((j) => j.id === connectionId);
    expect(mine).toHaveLength(1);

    await mine[0]!.remove();
  });

  afterAll(async () => {
    if (!hasRedis) return;
    const { getQueues } = await import("@/lib/queues");
    await Promise.all(Object.values(getQueues()).map((q) => q.close()));
  });
});
