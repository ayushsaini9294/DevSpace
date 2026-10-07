import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.ts';
import { getRedis } from '../realtime/redis.ts';
import { HttpError } from './http-error.ts';

/**
 * Rate limits (Phase 14), counted in Redis so several API processes share them. Each limit is a
 * fixed window per key (client IP, user or email). They are off when NODE_ENV=test unless
 * RATE_LIMITS=on, and RATE_LIMITS=off turns them off outside production (the e2e run), so tests
 * and e2e stay fast. If Redis doesn't answer, requests are let through
 * (logged): a Redis outage must not lock everyone out.
 */

export const RATE_LIMITED_MESSAGE = 'Too many tries. Please wait a minute and try again.';

export interface RateLimit {
  /** A short name, part of the Redis key. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** The key for this request (null skips the limit for it). */
  key: (req: Request) => string | null;
}

/** The client's address as Express sees it (TRUST_PROXY decides whether X-Forwarded-For counts). */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimitsOn(): boolean {
  if (env.RATE_LIMITS) return env.RATE_LIMITS === 'on';
  return env.NODE_ENV !== 'test';
}

/** Counts one request; returns the seconds to wait when it is over the limit, else null. */
async function take(limit: RateLimit, key: string): Promise<number | null> {
  const redisKey = `devspace:rate:${limit.name}:${key}`;
  const results = await getRedis()
    .multi()
    .set(redisKey, '0', 'PX', limit.windowMs, 'NX')
    .incr(redisKey)
    .pttl(redisKey)
    .exec();
  if (!results) return null;
  for (const [err] of results) if (err) throw err;
  const count = Number(results[1]![1]);
  if (count <= limit.limit) return null;
  const ttl = Number(results[2]![1]);
  return Math.max(1, Math.ceil((ttl > 0 ? ttl : limit.windowMs) / 1000));
}

/** Express middleware for one limit: 429 `rate_limited` with Retry-After when over it. */
export function rateLimit(limit: RateLimit): RequestHandler {
  return async (req, res, next) => {
    if (!rateLimitsOn()) return next();
    const key = limit.key(req);
    if (key === null) return next();
    let wait: number | null;
    try {
      wait = await take(limit, key);
    } catch (err) {
      console.error(
        `Rate limit ${limit.name} unavailable:`,
        err instanceof Error ? err.message : err,
      );
      return next();
    }
    if (wait === null) return next();
    res.set('Retry-After', String(wait));
    throw new HttpError(429, 'rate_limited', RATE_LIMITED_MESSAGE);
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const byUser = (req: Request) => (req.user ? `u:${req.user.id}` : null);

/** The email in a log-in body, lowercased (anything else counts as ''). */
function bodyEmail(req: Request): string {
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 320) : '';
}

/** The contract's limits (Phase 14). */
export const limits = {
  /** Log in: 10 per 15 min per IP + email. */
  login: rateLimit({
    name: 'login',
    limit: 10,
    windowMs: 15 * MINUTE,
    key: (req) => `${clientIp(req)}|${bodyEmail(req)}`,
  }),
  /** Sign up: 5 per hour per IP. */
  signup: rateLimit({ name: 'signup', limit: 5, windowMs: HOUR, key: clientIp }),
  /** Sending invitations: 30 per hour per user. */
  invite: rateLimit({ name: 'invite', limit: 30, windowMs: HOUR, key: byUser }),
  /** Starting and launching the IDE (and Preview launches): 30 per 10 min per user. */
  ide: rateLimit({ name: 'ide', limit: 30, windowMs: 10 * MINUTE, key: byUser }),
  /** Asking for AI reviews: 20 per hour per user. */
  aiReview: rateLimit({ name: 'ai-review', limit: 20, windowMs: HOUR, key: byUser }),
  /** Every other /api request: 600 per 5 min per user, or per IP when logged out. */
  general: rateLimit({
    name: 'api',
    limit: 600,
    windowMs: 5 * MINUTE,
    key: (req) => (req.path === '/health' ? null : (byUser(req) ?? `ip:${clientIp(req)}`)),
  }),
};
