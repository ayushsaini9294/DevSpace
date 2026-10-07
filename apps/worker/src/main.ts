import { z } from 'zod';
import { prisma } from '@devspace/api/prisma';
import { closeEmitter } from '@devspace/api/copy-updates';
import { startCopyUpdates } from './copy-updates.ts';
import { startHousekeeping } from './housekeeping.ts';
import { startAiReviews } from './ai-reviews.ts';
import { startGithubSync } from './github-sync.ts';

/**
 * The DevSpace worker: `npm run dev -w @devspace/worker` (or `start`). It reads apps/api/.env
 * (database, Docker socket, copies folder: the same settings as the API) plus REDIS_URL.
 */

const env = z
  .object({ REDIS_URL: z.string().trim().min(1).default('redis://localhost:6379') })
  // A blank REDIS_URL (e.g. compose's `${REDIS_URL:-}`) means "not set".
  .parse({ REDIS_URL: process.env.REDIS_URL?.trim() || undefined });

const housekeeping = await startHousekeeping({ redisUrl: env.REDIS_URL });
const copyUpdates = await startCopyUpdates({ redisUrl: env.REDIS_URL });
const aiReviews = await startAiReviews({ redisUrl: env.REDIS_URL });
const githubSync = await startGithubSync({ redisUrl: env.REDIS_URL });
console.log(
  `Worker running housekeeping every minute, copy updates, AI reviews and GitHub pushes (Redis ${new URL(env.REDIS_URL).host})`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down the worker`);
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();
  try {
    await githubSync.close();
    await aiReviews.close();
    await copyUpdates.close();
    await housekeeping.close();
    await closeEmitter();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Worker shutdown failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
