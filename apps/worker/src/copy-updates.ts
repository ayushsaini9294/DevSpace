import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  COPY_UPDATE_QUEUE,
  updateProjectCopies,
  type CopyUpdateJobData,
  type ProjectUpdateResult,
} from '@devspace/api/copy-updates';

/**
 * The automatic copy updates job (Phase 7): the API queues one per project after a merge or a
 * revert; this updates every copy of that project (clean ones are applied; conflicting ones are
 * left untouched with `pendingConflictPaths`; ones that changed meanwhile are retried by the
 * minute-by-minute housekeeping).
 */

export interface CopyUpdates {
  worker: Worker<CopyUpdateJobData, ProjectUpdateResult>;
  close(): Promise<void>;
}

export async function startCopyUpdates(options: {
  redisUrl: string;
  queueName?: string;
}): Promise<CopyUpdates> {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<CopyUpdateJobData, ProjectUpdateResult>(
    options.queueName ?? COPY_UPDATE_QUEUE,
    async (job: Job<CopyUpdateJobData>) => {
      const started = Date.now();
      const result = await updateProjectCopies(job.data.projectId);
      console.log(
        `Copy updates for project ${job.data.projectId}: ${result.updated.length} updated, ` +
          `${result.pending.length} left with conflicts, ${result.failed.length} to retry ` +
          `(${Date.now() - started} ms)`,
      );
      return result;
    },
    // One project at a time per worker; each copy update also takes the project's lock.
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    console.error(`Copy update job ${job?.id ?? '?'} failed:`, err.message);
  });
  await worker.waitUntilReady();
  return {
    worker,
    async close() {
      await worker.close();
      await connection.quit().catch(() => undefined);
    },
  };
}
