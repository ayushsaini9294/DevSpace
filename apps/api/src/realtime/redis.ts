import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

/**
 * One Redis connection for live-update commands (presence, rate limits, publishing). Commands
 * fail fast when Redis is down (callers log and carry on).
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
    client.on('error', () => undefined); // each failing command reports its own error
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  await c?.quit().catch(() => undefined);
}
