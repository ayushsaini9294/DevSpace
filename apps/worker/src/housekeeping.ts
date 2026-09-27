import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { runHousekeeping, type HousekeepingOptions } from '@devspace/api/housekeeping';

/**
 * The repeating housekeeping job (Phase 5 contract, "Worker"): every minute, stop IDEs idle for
 * 30 minutes and flag copies over 5 GB. BullMQ keeps one schedule per queue in Redis, so any
 * number of worker processes run it once a minute between them.
 */

export const QUEUE_NAME = 'devspace-housekeeping';
export const SCHEDULER_ID = 'every-minute';
export const JOB_NAME = 'housekeeping';
export const EVERY_MS = 60_000;

/** Job data: empty for the scheduled run; tests may limit a run to some copies. */
export type HousekeepingJobData = Pick<HousekeepingOptions, 'copyIds'>;

export interface Housekeeping {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

/** Adds (or updates) the every-minute schedule; idempotent across restarts and processes. */
export async function scheduleHousekeeping(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { every: EVERY_MS },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: 100, removeOnFail: 500 } },
  );
}

export async function startHousekeeping(options: {
  redisUrl: string;
  queueName?: string;
  /** Tests: don't add the every-minute schedule. */
  schedule?: boolean;
}): Promise<Housekeeping> {
  const queueName = options.queueName ?? QUEUE_NAME;
  // BullMQ workers need maxRetriesPerRequest: null (they block on Redis).
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<HousekeepingJobData>(queueName, { connection });
  const worker = new Worker<HousekeepingJobData>(
    queueName,
    async (job: Job<HousekeepingJobData>) => {
      const started = Date.now();
      const result = await runHousekeeping({ copyIds: job.data?.copyIds });
      const { idle, disk } = result;
      if (idle.stopped.length || idle.failed.length || disk.over.length || disk.failed.length) {
        console.log(
          `Housekeeping: stopped ${idle.stopped.length} idle IDE(s)` +
            (idle.failed.length ? ` (${idle.failed.length} failed)` : '') +
            `, ${disk.over.length} of ${disk.checked} copies over the disk limit` +
            (disk.failed.length ? `, ${disk.failed.length} not measured` : '') +
            ` (${Date.now() - started} ms)`,
        );
      }
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    console.error(`Housekeeping job ${job?.id ?? '?'} failed:`, err.message);
  });
  if (options.schedule !== false) await scheduleHousekeeping(queue);
  await worker.waitUntilReady();
  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit().catch(() => undefined);
    },
  };
}
