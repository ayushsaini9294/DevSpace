import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type Docker from 'dockerode';
import type { CopyView } from '@devspace/shared';
import { env } from '../config/env.ts';
import { copyDir, copySelect, ensureCopy, toView } from '../copies/service.ts';
import type { Identity } from '../git/repo.ts';
import { prisma } from '../lib/prisma.ts';
import { projectNotFound } from '../projects/access.ts';
import {
  containerLogTail,
  containerName,
  docker,
  envValue,
  ideBasePath,
  ideContainerSpec,
  ideNetworkIp,
  IDE_PORT,
  inspectIdeContainer,
  isConflict,
  isNotFound,
  matchesSpec,
  removeContainersByLabel,
} from './docker.ts';

/**
 * The IDE container of each copy: started on request, `starting` until OpenVSCode Server
 * answers, then `running` (or `failed` with a logged reason). One start per copy at a time.
 *
 * The connection token is made per container and passed in its environment. It is never
 * stored in the database or sent to the browser: the API keeps it in memory and, after a
 * restart, reads it back from the container's settings (readable only through Docker's
 * root-owned socket).
 */

/** How long a new IDE may take to answer before the start counts as failed. */
export const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;
/** `lastActiveAt` is written at most this often per copy. */
export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/** Where the API reaches a running IDE, and the token it adds to every request. */
export interface IdeTarget {
  ip: string;
  token: string;
}

const targets = new Map<string, IdeTarget>();
/** Starts in progress in this process, by copy id. */
const starts = new Map<string, { projectId: string; done: Promise<void> }>();
/** Serializes the "start or reuse" decision per copy, so two clicks start one container. */
const locks = new Map<string, Promise<unknown>>();
const lastActivityWrite = new Map<string, number>();

async function withCopyLock<T>(copyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(copyId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(copyId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(copyId) === tail) locks.delete(copyId);
  }
}

/** A new connection token: 43 characters of A-Z a-z 0-9 _ - (what VS Code accepts). */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure with a reason written for the logs. */
class StartFailure extends Error {}

/** Turns what Docker (or the socket) reported into a plain reason. */
function describeFailure(err: unknown): string {
  if (err instanceof StartFailure) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ECONNREFUSED') {
    return `Can't reach Docker at ${env.DOCKER_SOCKET} (${code})`;
  }
  if (isNotFound(err) && /image/i.test(message)) {
    return `The IDE image ${env.IDE_IMAGE} isn't built (run npm run ide:build)`;
  }
  if (isNotFound(err) && /network/i.test(message)) {
    return `The Docker network ${env.IDE_NETWORK} doesn't exist (run npm run ide:network)`;
  }
  return `Docker error: ${message.trim()}`;
}

/** The container for this copy, made (or remade) from today's settings and started. */
async function ensureContainer(copyId: string, projectId: string): Promise<string> {
  const input = { copyId, projectId, hostDir: copyDir(projectId, copyId) };
  let info = await inspectIdeContainer(copyId);
  if (info && !matchesSpec(info, input)) {
    console.log(`Recreating the IDE container of copy ${copyId}: its settings are out of date`);
    await docker.getContainer(info.Id).remove({ force: true });
    info = null;
  }
  if (!info) {
    try {
      await docker.createContainer(ideContainerSpec({ ...input, token: newToken() }));
    } catch (err) {
      // Another process made it first: use theirs.
      if (!isConflict(err)) throw err;
    }
    info = await inspectIdeContainer(copyId);
    if (!info) throw new StartFailure('The container disappeared right after it was created');
  }
  if (!info.State.Running) {
    try {
      await docker.getContainer(info.Id).start();
    } catch (err) {
      // 304: already started (by a concurrent start).
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 304) throw err;
    }
  }
  return info.Id;
}

/** GETs the IDE's start page with the token; resolves the HTTP status, or null. */
function probe(target: IdeTarget, copyId: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: target.ip,
        port: IDE_PORT,
        path: `${ideBasePath(copyId)}/`,
        headers: { cookie: `vscode-tkn=${target.token}` },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** The address and token of a container that is running now; null otherwise. */
function targetOf(info: Docker.ContainerInspectInfo | null): IdeTarget | null {
  if (!info?.State.Running) return null;
  const ip = ideNetworkIp(info);
  const token = envValue(info, 'DEVSPACE_CONNECTION_TOKEN');
  return ip && token ? { ip, token } : null;
}

/** Waits until the IDE answers on port 3000; throws a StartFailure with the reason if not. */
async function waitUntilReady(copyId: string): Promise<IdeTarget> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    let last: string;
    const info = await inspectIdeContainer(copyId);
    if (!info) throw new StartFailure('The container was removed while starting');
    if (!info.State.Running) {
      const logs = await containerLogTail(copyId);
      throw new StartFailure(
        `The container stopped while starting (exit code ${info.State.ExitCode})` +
          (logs ? `: ${logs}` : ''),
      );
    }
    const target = targetOf(info);
    if (!target) {
      last = `not attached to the ${env.IDE_NETWORK} network`;
    } else {
      const status = await probe(target, copyId);
      if (status !== null && status >= 200 && status < 400) return target;
      last = status === null ? 'no answer' : `HTTP ${status}`;
    }
    if (Date.now() >= deadline) {
      throw new StartFailure(
        `The IDE didn't answer on port ${IDE_PORT} within ${READY_TIMEOUT_MS / 1000} s (${last})`,
      );
    }
    await sleep(READY_POLL_MS);
  }
}

/** Runs one start in the background: container up, IDE answering, then `running`. */
async function runStart(copyId: string, projectId: string): Promise<void> {
  try {
    const containerId = await ensureContainer(copyId, projectId);
    await prisma.copy.updateMany({
      where: { id: copyId, containerStatus: 'starting' },
      data: { containerId },
    });
    const target = await waitUntilReady(copyId);
    const { count } = await prisma.copy.updateMany({
      where: { id: copyId, containerStatus: 'starting' },
      data: { containerStatus: 'running', lastActiveAt: new Date() },
    });
    if (count === 1) targets.set(copyId, target);
  } catch (err) {
    const reason = describeFailure(err);
    console.error(`The IDE of copy ${copyId} failed to start: ${reason}`);
    await prisma.copy
      .updateMany({
        where: { id: copyId, containerStatus: 'starting' },
        data: { containerStatus: 'failed', containerError: reason.slice(0, 2000) },
      })
      .catch((dbErr: unknown) =>
        console.error(
          `Could not mark the IDE of copy ${copyId} failed:`,
          dbErr instanceof Error ? dbErr.message : dbErr,
        ),
      );
    // Don't leave a broken IDE using memory; the files stay, and the next open retries.
    await docker
      .getContainer(containerName(copyId))
      .stop({ t: 2 })
      .catch(() => undefined);
  }
}

/** Marks the copy `starting` and starts it in the background. Call inside the copy's lock. */
async function beginStart(copyId: string, projectId: string) {
  targets.delete(copyId);
  const row = await prisma.copy.update({
    where: { id: copyId },
    data: { containerStatus: 'starting', containerError: null, lastActiveAt: new Date() },
    select: copySelect,
  });
  const done = runStart(copyId, projectId).finally(() => starts.delete(copyId));
  starts.set(copyId, { projectId, done });
  return row;
}

/**
 * POST /copy/ide: makes the member's copy if needed, then starts or reuses its IDE container.
 * Returns right away with `starting` or `running`.
 */
export async function openIde(
  projectId: string,
  user: Identity & { id: string },
): Promise<CopyView> {
  const { copy } = await ensureCopy(projectId, user);
  return withCopyLock(copy.id, async () => {
    const row = await prisma.copy.findUnique({ where: { id: copy.id }, select: copySelect });
    if (!row) throw projectNotFound(); // the project was deleted meanwhile
    if (starts.has(copy.id)) return toView(row);
    if (row.containerStatus === 'running') {
      const target = targetOf(await inspectIdeContainer(copy.id));
      if (target) {
        targets.set(copy.id, target);
        recordIdeActivity(copy.id);
        return toView(row);
      }
    }
    return toView(await beginStart(copy.id, projectId));
  });
}

/**
 * Where to send a running IDE's traffic: from memory, or (after a restart) read back from the
 * container. Null if the container isn't running.
 */
export async function getIdeTarget(copyId: string): Promise<IdeTarget | null> {
  const cached = targets.get(copyId);
  if (cached) return cached;
  const target = targetOf(await inspectIdeContainer(copyId));
  if (target) targets.set(copyId, target);
  return target;
}

/** Forget a cached address (e.g. the container stopped answering). */
export function forgetIdeTarget(copyId: string): void {
  targets.delete(copyId);
}

/** Records IDE use: `lastActiveAt` = now, written at most every 30 s per copy. */
export function recordIdeActivity(copyId: string): void {
  const now = Date.now();
  const last = lastActivityWrite.get(copyId);
  if (last !== undefined && now - last < ACTIVITY_WRITE_INTERVAL_MS) return;
  lastActivityWrite.set(copyId, now);
  prisma.copy
    .updateMany({ where: { id: copyId }, data: { lastActiveAt: new Date(now) } })
    .catch((err: unknown) =>
      console.error(
        `Could not record IDE activity for copy ${copyId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

/**
 * On API start: copies left `starting` or `running` by the previous process. A container that
 * is still running is watched again until it answers; any other goes to `stopped`.
 */
export async function recoverIdeContainers(): Promise<number> {
  const rows = await prisma.copy.findMany({
    where: { containerStatus: { in: ['starting', 'running'] } },
    select: { id: true, projectId: true },
  });
  for (const row of rows) {
    const info = await inspectIdeContainer(row.id);
    await withCopyLock(row.id, async () => {
      if (starts.has(row.id)) return;
      if (info?.State.Running) await beginStart(row.id, row.projectId);
      else {
        await prisma.copy.updateMany({
          where: { id: row.id, containerStatus: { in: ['starting', 'running'] } },
          data: { containerStatus: 'stopped' },
        });
      }
    });
  }
  return rows.length;
}

/** Stops a member's IDE (e.g. they left the project). Files are kept. Errors are logged. */
export async function stopMemberIde(projectId: string, userId: string): Promise<void> {
  try {
    const copy = await prisma.copy.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true },
    });
    if (!copy) return;
    await withCopyLock(copy.id, async () => {
      await starts.get(copy.id)?.done;
      targets.delete(copy.id);
      await prisma.copy.updateMany({
        where: { id: copy.id, containerStatus: { in: ['starting', 'running', 'failed'] } },
        data: { containerStatus: 'stopped' },
      });
      await docker
        .getContainer(containerName(copy.id))
        .stop({ t: 5 })
        .catch((err: unknown) => {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== 304 && !isNotFound(err)) throw err;
        });
    });
  } catch (err) {
    console.error(
      `Could not stop the IDE of user ${userId} in project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** After a project is deleted: waits for its starts, then removes all its IDE containers. */
export async function removeProjectContainers(projectId: string): Promise<void> {
  const pending = [...starts.values()].filter((s) => s.projectId === projectId);
  await Promise.all(pending.map((s) => s.done));
  await removeContainersByLabel(`devspace.project=${projectId}`);
}

/** Resolves once every start running in this process has finished (for tests and shutdown). */
export async function waitForIdeStarts(): Promise<void> {
  await Promise.all([...starts.values()].map((s) => s.done));
}
