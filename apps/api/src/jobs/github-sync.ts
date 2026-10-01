import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

/**
 * The `github-sync` job (Phase 13): after a publish, a merge or revert in keep-updated mode, a
 * switch to keep updated, or Try again, the API queues one job per project; the worker
 * (apps/worker) runs `runGithubSync` for it. Queueing is best effort: if Redis is down the
 * error is logged, and the worker's minute-by-minute housekeeping picks up links left waiting.
 */

export const GITHUB_SYNC_QUEUE = 'devspace-github-sync';
export const GITHUB_SYNC_JOB = 'github-sync';

export interface GithubSyncJobData {
  projectId: string;
}

const QUEUE_TIMEOUT_MS = 5_000;

let queueName: string | null = env.NODE_ENV === 'test' ? null : GITHUB_SYNC_QUEUE;
let connection: Redis | null = null;
let queue: Queue<GithubSyncJobData> | null = null;
/** Tests without a queue: the projects that would have been queued. */
const recorded: string[] = [];

function getQueue(name: string): Queue<GithubSyncJobData> {
  if (!queue || queue.name !== name) {
    connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
    queue = new Queue<GithubSyncJobData>(name, { connection });
  }
  return queue;
}

/** Queues a push of the project's main to GitHub (never throws). */
export async function queueGithubSync(projectId: string): Promise<void> {
  if (queueName === null) {
    recorded.push(projectId);
    return;
  }
  const name = queueName;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getQueue(name).add(
        GITHUB_SYNC_JOB,
        { projectId },
        { removeOnComplete: 100, removeOnFail: 500, attempts: 1 },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis did not answer')), QUEUE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(
      `Could not queue the GitHub push of project ${projectId} (housekeeping will retry):`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: `null` records queued projects in memory (the default under NODE_ENV=test). */
export function useGithubSyncQueue(name: string | null): void {
  queueName = name;
}

/** Tests: the projects queued since the last call (recording mode only). */
export function takeQueuedGithubSyncs(): string[] {
  return recorded.splice(0, recorded.length);
}

/** On shutdown. */
export async function closeGithubSyncQueue(): Promise<void> {
  const q = queue;
  const c = connection;
  queue = null;
  connection = null;
  await q?.close().catch(() => undefined);
  await c?.quit().catch(() => undefined);
}
