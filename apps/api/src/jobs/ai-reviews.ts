import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

/**
 * The AI review job (Phase 10): the API queues one job per AiReview row; the worker
 * (apps/worker) runs `runAiReview` for it. Under NODE_ENV=test jobs are recorded in memory
 * (tests run them directly), so API tests never hand jobs to a development worker.
 */

export const AI_REVIEW_QUEUE = 'devspace-ai-reviews';
export const AI_REVIEW_JOB = 'ai-review';

export interface AiReviewJobData {
  reviewId: string;
}

const QUEUE_TIMEOUT_MS = 5_000;

let queueName: string | null = env.NODE_ENV === 'test' ? null : AI_REVIEW_QUEUE;
let connection: Redis | null = null;
let queue: Queue<AiReviewJobData> | null = null;
const recorded: string[] = [];

function getQueue(name: string): Queue<AiReviewJobData> {
  if (!queue || queue.name !== name) {
    connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
    queue = new Queue<AiReviewJobData>(name, { connection });
  }
  return queue;
}

/** Queues the reviews. Throws if Redis can't take them (the caller marks them failed). */
export async function queueAiReviews(reviewIds: readonly string[]): Promise<void> {
  if (queueName === null) {
    recorded.push(...reviewIds);
    return;
  }
  const q = getQueue(queueName);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      q.addBulk(
        reviewIds.map((reviewId) => ({
          name: AI_REVIEW_JOB,
          data: { reviewId },
          opts: { jobId: reviewId, removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
        })),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis did not answer')), QUEUE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: `null` records queued reviews in memory; a name sends them to that BullMQ queue. */
export function useAiReviewQueue(name: string | null): void {
  queueName = name;
}

/** Tests: the reviews queued since the last call (recording mode only). */
export function takeQueuedAiReviews(): string[] {
  return recorded.splice(0, recorded.length);
}

export async function closeAiReviewQueue(): Promise<void> {
  const q = queue;
  const c = connection;
  queue = null;
  connection = null;
  await q?.close().catch(() => undefined);
  await c?.quit().catch(() => undefined);
}
