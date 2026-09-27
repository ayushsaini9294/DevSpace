import { Router } from 'express';
import { HealthResponseSchema, type HealthResponse } from '@devspace/shared';
import { prisma } from '../lib/prisma.ts';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  let body: HealthResponse;
  try {
    await prisma.$queryRaw`SELECT 1`;
    body = { status: 'ok', database: 'ok' };
  } catch (error) {
    console.error(
      'Health check: database unreachable:',
      error instanceof Error ? error.message : error,
    );
    body = { status: 'error', database: 'error' };
  }
  res.status(body.status === 'ok' ? 200 : 503).json(HealthResponseSchema.parse(body));
});
