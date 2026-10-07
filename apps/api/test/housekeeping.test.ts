import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CopyResponseSchema,
  IdeLaunchResponseSchema,
  RepositoryResponseSchema,
  type CopyView,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { copyDir } from '../src/copies/service.ts';
import { checkCopySizes, IDLE_LIMIT_MS, stopIdleIdes } from '../src/housekeeping/index.ts';
import { containerName, docker } from '../src/ide/docker.ts';
import { createIdeServer } from '../src/ide/proxy.ts';
import { ideHostFor, ideOriginFor } from '../src/ide/origin.ts';
import { ideRequest } from './ide-host.ts';
import { forgetIdeActivityWrite, waitForIdeStarts } from '../src/ide/service.ts';
import { prisma } from '../src/lib/prisma.ts';
import { as, cleanUp, createProject, createTeam, signUp, type TestUser } from './helpers.ts';

// ---------- What this machine can run ----------

async function probe(): Promise<{ docker: boolean; ide: boolean; why: string }> {
  try {
    await docker.ping();
  } catch (err) {
    return {
      docker: false,
      ide: false,
      why: `Docker isn't reachable at ${env.DOCKER_SOCKET} (${err instanceof Error ? err.message : err})`,
    };
  }
  try {
    await docker.getImage(env.IDE_IMAGE).inspect();
    await docker.getNetwork(env.IDE_NETWORK).inspect();
  } catch {
    return { docker: true, ide: false, why: `image ${env.IDE_IMAGE} or network missing` };
  }
  return { docker: true, ide: true, why: '' };
}
const available = await probe();
if (!available.docker) console.warn(`SKIPPING the Docker housekeeping tests: ${available.why}`);
else if (!available.ide) console.warn(`SKIPPING the real IDE housekeeping tests: ${available.why}`);

// ---------- Helpers ----------

const startedCopies = new Set<string>();
let ideServer: Server;
beforeAll(async () => {
  ideServer = createIdeServer();
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  await waitForIdeStarts();
  if (available.docker) {
    for (const id of startedCopies) {
      await docker
        .getContainer(containerName(id))
        .remove({ force: true })
        .catch(() => undefined);
    }
  }
  ideServer.closeAllConnections();
  await new Promise((resolve) => ideServer.close(resolve));
  await cleanUp();
});

async function newProject(name = 'Housekeeping') {
  const leader = await signUp('Hal Housekeeper');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, name);
  const res = await as(leader).post(`/api/projects/${project.id}/repository`, { source: 'empty' });
  expect(RepositoryResponseSchema.parse(res.body).repository.status).toBe('ready');
  return { leader, project };
}

async function plainCopy(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).post(`/api/projects/${projectId}/copy`);
  expect(res.status).toBe(201);
  return CopyResponseSchema.parse(res.body).copy!;
}

async function openIde(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).post(`/api/projects/${projectId}/copy/ide`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const copy = CopyResponseSchema.parse(res.body).copy!;
  startedCopies.add(copy.id);
  return copy;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function setRow(
  copyId: string,
  data: {
    containerStatus?: 'running' | 'starting' | 'failed';
    lastActiveAt?: Date | null;
    createdAt?: Date;
  },
) {
  await prisma.copy.update({ where: { id: copyId }, data });
}

const statusOf = async (copyId: string) =>
  (await prisma.copy.findUniqueOrThrow({ where: { id: copyId } })).containerStatus;

async function containerRunning(copyId: string): Promise<boolean> {
  try {
    return (await docker.getContainer(containerName(copyId)).inspect()).State.Running;
  } catch {
    return false;
  }
}

/** A running IDE, ready to use. */
async function runningIde() {
  const { leader, project } = await newProject();
  const copy = await openIde(leader, project.id);
  await waitForIdeStarts();
  const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
  expect(row.containerStatus, row.containerError ?? '').toBe('running');
  return { leader, project, copy };
}

// ---------- Disk use (no Docker needed) ----------

describe('copy disk use', () => {
  it('stores each copy folder’s size and flags copies over the limit, then clears the flag', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    const dir = copyDir(project.id, copy.id);
    const limit = 2 * 1024 * 1024;

    let result = await checkCopySizes({ copyIds: [copy.id], diskLimitBytes: limit });
    expect(result).toEqual({ checked: 1, over: [], failed: [] });
    let row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.overDiskLimit).toBe(false);
    expect(Number(row.diskBytes)).toBeGreaterThan(0);
    expect(row.diskCheckedAt).not.toBeNull();

    // 3 MB of real (non-sparse) data.
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    result = await checkCopySizes({ copyIds: [copy.id], diskLimitBytes: limit });
    expect(result.over).toEqual([copy.id]);
    row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.overDiskLimit).toBe(true);
    expect(Number(row.diskBytes)).toBeGreaterThan(3 * 1024 * 1024);

    rmSync(join(dir, 'big.bin'));
    result = await checkCopySizes({ copyIds: [copy.id], diskLimitBytes: limit });
    expect(result.over).toEqual([]);
    expect((await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } })).overDiskLimit).toBe(
      false,
    );

    // The flag isn't part of the browser's view (yet).
    const view = await as(leader).get(`/api/projects/${project.id}/copy`);
    expect(JSON.stringify(view.body)).not.toMatch(/disk/i);
  });

  it('a copy whose folder is missing is reported, not flagged', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    rmSync(copyDir(project.id, copy.id), { recursive: true, force: true });
    const result = await checkCopySizes({ copyIds: [copy.id] });
    expect(result).toEqual({ checked: 0, over: [], failed: [copy.id] });
    expect((await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } })).overDiskLimit).toBe(
      false,
    );
  });
});

// ---------- Idle IDEs: which rows (Docker reachable; these copies have no container) ----------

describe.skipIf(!available.docker)('idle IDEs (needs Docker)', () => {
  it('stops only running copies idle for over 30 minutes, counting from creation if never used', async () => {
    const { leader, project } = await newProject();
    const { leader: l2, project: p2 } = await newProject('Two');
    const { leader: l3, project: p3 } = await newProject('Three');
    const { leader: l4, project: p4 } = await newProject('Four');
    const idle = await plainCopy(leader, project.id);
    const fresh = await plainCopy(l2, p2.id);
    const neverUsed = await plainCopy(l3, p3.id);
    const starting = await plainCopy(l4, p4.id);
    await setRow(idle.id, { containerStatus: 'running', lastActiveAt: minutesAgo(31) });
    await setRow(fresh.id, { containerStatus: 'running', lastActiveAt: minutesAgo(29) });
    await setRow(neverUsed.id, {
      containerStatus: 'running',
      lastActiveAt: null,
      createdAt: minutesAgo(45),
    });
    await setRow(starting.id, { containerStatus: 'starting', lastActiveAt: minutesAgo(60) });
    const ids = [idle.id, fresh.id, neverUsed.id, starting.id];

    const result = await stopIdleIdes({ copyIds: ids });
    expect(result.failed).toEqual([]);
    expect(result.stopped.sort()).toEqual([idle.id, neverUsed.id].sort());
    expect(await statusOf(idle.id)).toBe('stopped');
    expect(await statusOf(neverUsed.id)).toBe('stopped');
    expect(await statusOf(fresh.id)).toBe('running');
    expect(await statusOf(starting.id)).toBe('starting');
    // Files are kept.
    expect(existsSync(join(copyDir(project.id, idle.id), 'README.md'))).toBe(true);
    // A second run has nothing to do.
    expect((await stopIdleIdes({ copyIds: ids })).stopped).toEqual([]);
    expect(IDLE_LIMIT_MS).toBe(30 * 60_000);
  });
});

// ---------- Idle IDEs: real containers ----------

describe.skipIf(!available.ide)('idle IDEs with real containers', () => {
  it(
    'stops an idle container, keeps its files, and the next open starts it again',
    { timeout: 180_000 },
    async () => {
      const { leader, project, copy } = await runningIde();
      const info = await docker.getContainer(containerName(copy.id)).inspect();
      await setRow(copy.id, { lastActiveAt: minutesAgo(31) });

      expect((await stopIdleIdes({ copyIds: [copy.id] })).stopped).toEqual([copy.id]);
      expect(await statusOf(copy.id)).toBe('stopped');
      expect(await containerRunning(copy.id)).toBe(false);
      expect(existsSync(join(copyDir(project.id, copy.id), 'README.md'))).toBe(true);
      const launch = await as(leader).post(`/api/projects/${project.id}/copy/ide/launch`);
      expect(launch.status).toBe(409);

      const again = await openIde(leader, project.id);
      expect(again.containerStatus).toBe('starting');
      await waitForIdeStarts();
      expect(await statusOf(copy.id)).toBe('running');
      expect(await containerRunning(copy.id)).toBe(true);
      expect((await docker.getContainer(containerName(copy.id)).inspect()).Id).toBe(info.Id);
    },
  );

  it(
    'a stop racing an open never leaves the status and the container disagreeing',
    { timeout: 240_000 },
    async () => {
      const { leader, project, copy } = await runningIde();
      for (let round = 0; round < 4; round++) {
        await setRow(copy.id, { containerStatus: 'running', lastActiveAt: minutesAgo(31) });
        // Alternate which one is called first.
        const calls = [
          () => stopIdleIdes({ copyIds: [copy.id] }),
          () => as(leader).post(`/api/projects/${project.id}/copy/ide`),
        ];
        if (round % 2) calls.reverse();
        await Promise.all(calls.map((call) => call()));
        await waitForIdeStarts();
        const status = await statusOf(copy.id);
        const running = await containerRunning(copy.id);
        expect({ round, status, running }).toEqual({ round, status: 'running', running: true });
      }
    },
  );

  it(
    'an open WebSocket keeps the IDE active: its traffic updates lastActiveAt',
    { timeout: 180_000 },
    async () => {
      const { leader, project, copy } = await runningIde();
      const launch = await as(leader).post(`/api/projects/${project.id}/copy/ide/launch`);
      const redeemed = await ideRequest(ideServer).get(
        IdeLaunchResponseSchema.parse(launch.body).url,
      );
      expect(redeemed.status).toBe(303);
      const raw = redeemed.headers['set-cookie'] as unknown as string[];
      const cookie = raw
        .map((c) => c.split(';')[0]!)
        .filter((c) => c.startsWith('devspace_ide='))
        .join('; ');

      // Open a WebSocket through the IDE site and keep it open.
      const { port } = ideServer.address() as AddressInfo;
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      const path = `/ide/${copy.id}/?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${ideHostFor(copy.id)}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Origin: ${ideOriginFor(copy.id)}`,
          `Cookie: ${cookie}`,
          '',
          '',
        ].join('\r\n'),
      );
      const status = await new Promise<string>((resolve) =>
        socket.once('data', (d) => resolve(d.toString('latin1').split('\r\n')[0]!)),
      );
      expect(status).toMatch(/^HTTP\/1\.1 101/);

      // Idle for 31 minutes as far as the database knows; then the browser sends a frame
      // (a masked, empty WebSocket ping, as a keep-alive would).
      await setRow(copy.id, { lastActiveAt: minutesAgo(31) });
      forgetIdeActivityWrite(copy.id);
      socket.write(Buffer.from([0x89, 0x80, 1, 2, 3, 4]));
      let fresh = false;
      for (let i = 0; i < 40 && !fresh; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
        fresh = row.lastActiveAt!.getTime() > Date.now() - 60_000;
      }
      expect(fresh).toBe(true);
      expect((await stopIdleIdes({ copyIds: [copy.id] })).stopped).toEqual([]);
      expect(await containerRunning(copy.id)).toBe(true);
      socket.destroy();
    },
  );
});
