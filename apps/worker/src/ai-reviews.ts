import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { AI_REVIEW_QUEUE, runAiReview, type AiReviewJobData } from '@devspace/api/ai-reviews';

/**
 * The AI review job (Phase 10): the API queues one job per model review; this runs it (asks
 * OpenRouter with the requester's key, falls back, stores the findings). Several at once: each
 * mostly waits on OpenRouter.
 */

export interface AiReviews {
  worker: Worker<AiReviewJobData>;
  close(): Promise<void>;
}

export async function startAiReviews(options: {
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
}): Promise<AiReviews> {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<AiReviewJobData>(
    options.queueName ?? AI_REVIEW_QUEUE,
    async (job: Job<AiReviewJobData>) => {
      const started = Date.now();
      await runAiReview(job.data.reviewId);
      console.log(`AI review ${job.data.reviewId} finished (${Date.now() - started} ms)`);
    },
    // A review can wait a minute or more per model; don't let BullMQ think it stalled.
    { connection, concurrency: options.concurrency ?? 6, lockDuration: 5 * 60_000 },
  );
  worker.on('failed', (job, err) => {
    console.error(`AI review job ${job?.id ?? '?'} failed:`, err.message);
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
