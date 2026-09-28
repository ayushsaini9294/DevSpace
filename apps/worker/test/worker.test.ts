import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@devspace/api/prisma';
import { Queue } from 'bullmq';
import {
  closeCopyUpdateQueue,
  queueCopyUpdates,
  useCopyUpdateQueue,
} from '@devspace/api/copy-updates';
import { startCopyUpdates } from '../src/copy-updates.ts';
import {
  EVERY_MS,
  JOB_NAME,
  SCHEDULER_ID,
  scheduleHousekeeping,
  startHousekeeping,
  type Housekeeping,
} from '../src/housekeeping.ts';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function redisReachable(): Promise<string> {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    return '';
  } catch (err) {
    return `Redis isn't reachable at ${REDIS_URL} (${err instanceof Error ? err.message : err})`;
  } finally {
    client.disconnect();
  }
}

const why = await redisReachable();
if (why) console.warn(`SKIPPING the worker tests: ${why}`);

// Rows these tests make, deleted at the end (users cascade to everything else).
const userIds: string[] = [];
let housekeeping: Housekeeping | undefined;

afterAll(async () => {
  if (housekeeping) {
    await housekeeping.queue.obliterate({ force: true });
    await housekeeping.close();
  }
  await prisma.team.deleteMany({ where: { ownerId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/** A copy row (and its folder) with no container, `running` and idle for 31 minutes. */
async function idleCopy() {
  const user = await prisma.user.create({
    data: { name: 'Worker Test', email: `worker-${randomUUID()}@example.test`, passwordHash: 'x' },
  });
  userIds.push(user.id);
  const team = await prisma.team.create({ data: { name: 'Worker Team', ownerId: user.id } });
  const project = await prisma.project.create({
    data: { teamId: team.id, name: 'Worker Project', settings: {} },
  });
  const copy = await prisma.copy.create({
    data: {
      projectId: project.id,
      userId: user.id,
      branchName: `copy/${user.id}`,
      containerStatus: 'running',
      lastActiveAt: new Date(Date.now() - 31 * 60_000),
    },
  });
  const dir = join(process.env.COPIES_DIR!, project.id, copy.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  return copy;
}

describe.skipIf(!!why)('the copy updates job (needs Redis)', () => {
  it('runs the jobs the API queues after a merge or revert', { timeout: 60_000 }, async () => {
    const queueName = `devspace-copy-updates-test-${randomUUID()}`;
    const updates = await startCopyUpdates({ redisUrl: REDIS_URL, queueName });
    try {
      // A project in automatic mode with no repository yet: the job runs and has nothing to do.
      const user = await prisma.user.create({
        data: {
          name: 'Worker Test',
          email: `worker-${randomUUID()}@example.test`,
          passwordHash: 'x',
        },
      });
      userIds.push(user.id);
      const team = await prisma.team.create({ data: { name: 'Worker Team', ownerId: user.id } });
      const project = await prisma.project.create({
        data: { teamId: team.id, name: 'Worker Project', settings: {} },
      });
      const done = new Promise<unknown>((resolve, reject) => {
        updates.worker.on('completed', (job, result) => {
          if (job.data.projectId === project.id) resolve(result);
        });
        updates.worker.on('failed', (job, err) => {
          if (job?.data.projectId === project.id) reject(err);
        });
      });
      // Queued exactly as the API does it.
      useCopyUpdateQueue(queueName);
      await queueCopyUpdates(project.id);
      expect(await done).toEqual({ updated: [], pending: [], upToDate: [], failed: [] });
    } finally {
      useCopyUpdateQueue(null);
      await closeCopyUpdateQueue();
      const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const queue = new Queue(queueName, { connection });
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
      await updates.close();
    }
  });
});

describe.skipIf(!!why)('the worker (needs Redis; stopping needs Docker)', () => {
  it(
    'schedules housekeeping every minute and runs it through BullMQ',
    { timeout: 60_000 },
    async () => {
      // The schedule, on a queue with no worker (a scheduled run would cover every copy in the
      // shared development database).
      const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const scheduleOnly = new Queue(`devspace-housekeeping-test-${randomUUID()}`, { connection });
      await scheduleHousekeeping(scheduleOnly);
      await scheduleHousekeeping(scheduleOnly); // idempotent
      const schedulers = await scheduleOnly.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ key: SCHEDULER_ID, name: JOB_NAME, every: EVERY_MS });
      await scheduleOnly.obliterate({ force: true });
      await scheduleOnly.close();
      await connection.quit();

      // The worker on its own queue, so a worker running in development is not disturbed.
      housekeeping = await startHousekeeping({
        redisUrl: REDIS_URL,
        queueName: `devspace-housekeeping-test-${randomUUID()}`,
        schedule: false,
      });

      // One run, limited to this test's copy (the scheduled run covers every copy).
      const copy = await idleCopy();
      const done = new Promise<unknown>((resolve, reject) => {
        housekeeping!.worker.on('completed', (job, result) => {
          if (job.data?.copyIds?.[0] === copy.id) resolve(result);
        });
        housekeeping!.worker.on('failed', (job, err) => {
          if (job?.data?.copyIds?.[0] === copy.id) reject(err);
        });
      });
      await housekeeping.queue.add(JOB_NAME, { copyIds: [copy.id] });
      const result = (await done) as {
        idle: { stopped: string[]; failed: string[] };
        disk: { checked: number; over: string[] };
      };

      // Stopping a copy with no container needs Docker to answer "no such container".
      const dockerDown = result.idle.failed.includes(copy.id);
      if (dockerDown) console.warn('Docker unreachable: the stop was retried later, as designed');
      else expect(result.idle.stopped).toEqual([copy.id]);
      const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
      expect(row.containerStatus).toBe(dockerDown ? 'running' : 'stopped');
      expect(result.disk).toMatchObject({ checked: 1, over: [] });
      expect(Number(row.diskBytes)).toBeGreaterThan(0);
      expect(row.overDiskLimit).toBe(false);
    },
  );
});
