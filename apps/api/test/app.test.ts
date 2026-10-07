import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@devspace/shared';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { closeRedis } from '../src/realtime/redis.ts';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('GET /api/health', () => {
  it('returns 200 when the real database and Redis answer, and nothing else', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true, redis: true });
    expect(HealthResponseSchema.parse(res.body)).toEqual(res.body);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'not_found', message: 'Route not found' });
  });
});

describe('API security headers (Phase 14)', () => {
  it('every /api answer is nosniff, has a Referrer-Policy and is never cached', async () => {
    for (const res of [
      await request(app).get('/api/does-not-exist'),
      await request(app).get('/api/auth/me'),
      await request(app).post('/api/auth/login').send({ email: 'x@example.test', password: 'x' }),
    ]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });
});

describe('rate limits in tests', () => {
  it('are off by default when NODE_ENV=test (RATE_LIMITS unset)', async () => {
    const email = `limits-off-${crypto.randomUUID()}@example.test`;
    for (let i = 0; i < 12; i++) {
      const res = await request(app).post('/api/auth/login').send({ email, password: 'wrong-one' });
      expect(res.status).toBe(401);
    }
  });
});
