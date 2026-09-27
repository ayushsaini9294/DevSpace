import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@devspace/shared';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/health', () => {
  it('returns 200 with database ok against the real database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(res.body)).toEqual({ status: 'ok', database: 'ok' });
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
