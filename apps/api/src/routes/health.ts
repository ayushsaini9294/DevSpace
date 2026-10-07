import { Router } from 'express';
import { HealthResponseSchema, type HealthResponse } from '@devspace/shared';
import { prisma } from '../lib/prisma.ts';
import { getRedis } from '../realtime/redis.ts';

export const healthRouter = Router();

/** How long one check may take before it counts as not answering. */
const CHECK_TIMEOUT_MS = 2_000;

/** True when `check` finishes in time; logs (without details beyond the message) when not. */
async function answers(name: string, check: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    console.error(
      `Health check: ${name} unreachable:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

healthRouter.get('/health', async (_req, res) => {
  const [db, redis] = await Promise.all([
    answers('database', () => prisma.$queryRaw`SELECT 1`),
    answers('Redis', () => getRedis().ping()),
  ]);
  const body: HealthResponse = { ok: db && redis, db, redis };
  res.status(body.ok ? 200 : 503).json(HealthResponseSchema.parse(body));
});
