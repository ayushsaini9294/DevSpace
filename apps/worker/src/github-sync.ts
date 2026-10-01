import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  GITHUB_SYNC_QUEUE,
  runGithubSync,
  type GithubSyncJobData,
  type SyncResult,
} from '@devspace/api/github-sync';

/**
 * The `github-sync` job (Phase 13): pushes a project's main to its linked GitHub repository
 * (never forced). The API queues one after a publish, a merge or revert in keep-updated mode,
 * and Try again; the minute-by-minute housekeeping retries failed pushes.
 */

export interface GithubSync {
  worker: Worker<GithubSyncJobData, SyncResult>;
  close(): Promise<void>;
}

export async function startGithubSync(options: {
  redisUrl: string;
  queueName?: string;
}): Promise<GithubSync> {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<GithubSyncJobData, SyncResult>(
    options.queueName ?? GITHUB_SYNC_QUEUE,
    async (job: Job<GithubSyncJobData>) => {
      const started = Date.now();
      const result = await runGithubSync(job.data.projectId);
      console.log(
        `GitHub push for project ${job.data.projectId}: ${result} (${Date.now() - started} ms)`,
      );
      return result;
    },
    // Pushes of different projects may run side by side; one project is guarded by its claim.
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    console.error(`GitHub push job ${job?.id ?? '?'} failed:`, err.message);
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
