import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

/**
 * The automatic copy updates job (Phase 7): after a merge or revert the API queues one job per
 * project; the worker (apps/worker) runs `updateProjectCopies` for it. Queueing is best effort:
 * if Redis is down the error is logged, and the worker's minute-by-minute housekeeping updates
 * every copy that is still behind anyway.
 */

export const COPY_UPDATE_QUEUE = 'devspace-copy-updates';
export const COPY_UPDATE_JOB = 'update-project-copies';

export interface CopyUpdateJobData {
  projectId: string;
}

const QUEUE_TIMEOUT_MS = 5_000;

let queueName: string | null = env.NODE_ENV === 'test' ? null : COPY_UPDATE_QUEUE;
let connection: Redis | null = null;
let queue: Queue<CopyUpdateJobData> | null = null;
/** Tests without a queue: the projects that would have been queued. */
const recorded: string[] = [];

function getQueue(name: string): Queue<CopyUpdateJobData> {
  if (!queue || queue.name !== name) {
    connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
    queue = new Queue<CopyUpdateJobData>(name, { connection });
  }
  return queue;
}

/** Queues the automatic update of every copy of the project (never throws). */
export async function queueCopyUpdates(projectId: string): Promise<void> {
  if (queueName === null) {
    recorded.push(projectId);
    return;
  }
  const name = queueName;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getQueue(name).add(
        COPY_UPDATE_JOB,
        { projectId },
        { removeOnComplete: 100, removeOnFail: 500, attempts: 1 },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis did not answer')), QUEUE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(
      `Could not queue the copy updates of project ${projectId} (housekeeping will retry):`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tests: `null` records queued projects in memory (the default under NODE_ENV=test, so API tests
 * never hand jobs to a development worker); a name sends them to that BullMQ queue.
 */
export function useCopyUpdateQueue(name: string | null): void {
  queueName = name;
}

/** Tests: the projects queued since the last call (recording mode only). */
export function takeQueuedCopyUpdates(): string[] {
  return recorded.splice(0, recorded.length);
}

/** On shutdown. */
export async function closeCopyUpdateQueue(): Promise<void> {
  const q = queue;
  const c = connection;
  queue = null;
  connection = null;
  await q?.close().catch(() => undefined);
  await c?.quit().catch(() => undefined);
}
