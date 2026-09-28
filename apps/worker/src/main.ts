import { z } from 'zod';
import { prisma } from '@devspace/api/prisma';
import { startCopyUpdates } from './copy-updates.ts';
import { startHousekeeping } from './housekeeping.ts';

/**
 * The DevSpace worker: `npm run dev -w @devspace/worker` (or `start`). It reads apps/api/.env
 * (database, Docker socket, copies folder: the same settings as the API) plus REDIS_URL.
 */

const env = z
  .object({ REDIS_URL: z.string().trim().min(1).default('redis://localhost:6379') })
  .parse(process.env);

const housekeeping = await startHousekeeping({ redisUrl: env.REDIS_URL });
const copyUpdates = await startCopyUpdates({ redisUrl: env.REDIS_URL });
console.log(
  `Worker running housekeeping every minute and copy updates (Redis ${new URL(env.REDIS_URL).host})`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down the worker`);
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();
  try {
    await copyUpdates.close();
    await housekeeping.close();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Worker shutdown failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
