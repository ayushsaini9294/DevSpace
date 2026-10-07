import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Redis that never answers (nothing listens on port 1); the database is the real one.
vi.hoisted(() => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
});

const { createApp } = await import('../src/app.ts');
const { prisma } = await import('../src/lib/prisma.ts');
const { closeRedis } = await import('../src/realtime/redis.ts');

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('GET /api/health when Redis is down', () => {
  it('answers 503 and says which part is down', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: true, redis: false });
  });
});
