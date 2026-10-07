import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorResponseSchema } from '@devspace/shared';

// The one API test file that turns rate limits on (they are off in NODE_ENV=test otherwise).
vi.hoisted(() => {
  process.env.RATE_LIMITS = 'on';
});

const { createApp } = await import('../src/app.ts');
const { prisma } = await import('../src/lib/prisma.ts');
const { closeRedis, getRedis } = await import('../src/realtime/redis.ts');
const { RATE_LIMITED_MESSAGE } = await import('../src/lib/rate-limit.ts');

/** Behind a proxy we trust (like Caddy with TRUST_PROXY=loopback). */
const proxied = createApp({ trustProxy: 'loopback' });
/** No TRUST_PROXY: X-Forwarded-For is ignored. */
const direct = createApp({ trustProxy: false });

const emails: string[] = [];
const uniqueEmail = (prefix: string) => {
  const email = `${prefix}-${crypto.randomUUID()}@example.test`;
  emails.push(email);
  return email;
};
/** A random documentation-range address, so runs never share a bucket. */
const randomIp = () => `198.51.${randomInt(256)}.${randomInt(1, 255)}`;

async function clearLoopbackBuckets() {
  const keys = await getRedis().keys('devspace:rate:api:ip:*127.0.0.1');
  if (keys.length > 0) await getRedis().del(...keys);
}

beforeAll(clearLoopbackBuckets);

afterAll(async () => {
  await clearLoopbackBuckets();
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
  await closeRedis();
});

function login(app: ReturnType<typeof createApp>, email: string, ip?: string) {
  const req = request(app).post('/api/auth/login');
  if (ip) req.set('X-Forwarded-For', ip);
  return req.send({ email, password: 'not-the-password' });
}

function expectLimited(res: request.Response) {
  expect(res.status, JSON.stringify(res.body)).toBe(429);
  expect(ErrorResponseSchema.parse(res.body)).toEqual({
    error: 'rate_limited',
    message: RATE_LIMITED_MESSAGE,
  });
  expect(res.body.message).toBe('Too many tries. Please wait a minute and try again.');
  const wait = Number(res.headers['retry-after']);
  expect(Number.isInteger(wait)).toBe(true);
  return wait;
}

describe('rate limits (RATE_LIMITS=on)', () => {
  it('log in: 10 tries per 15 minutes per IP and email, then 429 with Retry-After', async () => {
    const ip = randomIp();
    const email = uniqueEmail('limit-login');
    for (let i = 0; i < 10; i++) expect((await login(proxied, email, ip)).status).toBe(401);
    const wait = expectLimited(await login(proxied, email, ip));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    // The same email from another address, and another email from this one, are separate.
    expect((await login(proxied, email, randomIp())).status).toBe(401);
    expect((await login(proxied, uniqueEmail('limit-login'), ip)).status).toBe(401);
    // Email case doesn't make a new bucket.
    expectLimited(await login(proxied, email.toUpperCase(), ip));
  });

  it('sign up: 5 per hour per IP', async () => {
    const ip = randomIp();
    const signup = (email: string) =>
      request(proxied)
        .post('/api/auth/signup')
        .set('X-Forwarded-For', ip)
        .send({ name: 'Rate Tester', email, password: 'a-good-password' });
    for (let i = 0; i < 5; i++) {
      expect((await signup(uniqueEmail('limit-signup'))).status).toBe(201);
    }
    const email = uniqueEmail('limit-signup');
    const wait = expectLimited(await signup(email));
    expect(wait).toBeLessThanOrEqual(60 * 60);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('trust proxy: X-Forwarded-For counts only when TRUST_PROXY is set', async () => {
    // Not trusted: every request is the loopback peer, whatever X-Forwarded-For says.
    const email = uniqueEmail('limit-trust');
    for (let i = 0; i < 10; i++) {
      expect((await login(direct, email, randomIp())).status).toBe(401);
    }
    expectLimited(await login(direct, email, randomIp()));

    // Trusted: the forwarded address is the client, so another address has its own bucket.
    const other = uniqueEmail('limit-trust');
    const ip = randomIp();
    for (let i = 0; i < 10; i++) expect((await login(proxied, other, ip)).status).toBe(401);
    expectLimited(await login(proxied, other, ip));
    expect((await login(proxied, other, randomIp())).status).toBe(401);
  });
});
