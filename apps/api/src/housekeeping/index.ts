import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyDir } from '../copies/service.ts';
import { retryBehindCopies, type ProjectUpdateResult } from '../copies/update.ts';
import { containerName, docker, isNotFound } from '../ide/docker.ts';
import { withCopyDbLock } from '../ide/lock.ts';
import { prisma } from '../lib/prisma.ts';

/**
 * Housekeeping the worker runs every minute (apps/worker imports this module, so it shares the
 * API's Docker and database code). Everything here is safe to run from several processes and
 * alongside the API.
 */

const run = promisify(execFile);

/** An IDE with no traffic for this long is stopped (its files are kept). */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
/** A copy folder over this size is flagged. */
export const DISK_LIMIT_BYTES = 5 * 1024 ** 3;
const DU_TIMEOUT_MS = 5 * 60_000;

export interface HousekeepingOptions {
  /** "Now", for tests. */
  now?: Date;
  /** Limit the run to these copies (tests); all copies otherwise. */
  copyIds?: string[];
  idleLimitMs?: number;
  diskLimitBytes?: number;
}

export interface IdleResult {
  stopped: string[];
  /** Copies whose container could not be stopped (they stay `running`; retried next run). */
  failed: string[];
}

/** Idle for too long: the last activity (or, if none, the copy's creation) is before `cutoff`. */
function idleWhere(cutoff: Date) {
  return {
    containerStatus: 'running' as const,
    OR: [{ lastActiveAt: { lt: cutoff } }, { lastActiveAt: null, createdAt: { lt: cutoff } }],
  };
}

/**
 * Stops the IDE containers of copies that have been idle for over 30 minutes and marks them
 * `stopped`. Each stop happens under the copy's database lock, re-checking the row first, so a
 * simultaneous POST …/copy/ide (which takes the same lock) either sees `stopped` and starts the
 * container again, or has already refreshed `lastActiveAt` and this run leaves the copy alone.
 */
export async function stopIdleIdes(options: HousekeepingOptions = {}): Promise<IdleResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.idleLimitMs ?? IDLE_LIMIT_MS));
  const idFilter = options.copyIds ? { id: { in: options.copyIds } } : {};
  const candidates = await prisma.copy.findMany({
    where: { ...idFilter, ...idleWhere(cutoff) },
    select: { id: true },
  });
  const result: IdleResult = { stopped: [], failed: [] };
  for (const { id } of candidates) {
    try {
      const stopped = await withCopyDbLock(id, async (tx) => {
        const still = await tx.copy.count({ where: { id, ...idleWhere(cutoff) } });
        if (still === 0) return false; // opened again meanwhile
        try {
          await docker.getContainer(containerName(id)).stop({ t: 10 });
        } catch (err) {
          // 304: already stopped; 404: gone. Either way nothing is running.
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== 304 && !isNotFound(err)) throw err;
        }
        await tx.copy.update({ where: { id }, data: { containerStatus: 'stopped' } });
        return true;
      });
      if (stopped) {
        result.stopped.push(id);
        console.log(`Stopped the idle IDE of copy ${id} (no activity for 30 minutes)`);
      }
    } catch (err) {
      result.failed.push(id);
      console.error(
        `Could not stop the idle IDE of copy ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

/** The folder's size on disk in bytes (`du`, not following symlinks or other filesystems). */
export async function folderDiskBytes(dir: string): Promise<number> {
  const { stdout } = await run('du', ['-s', '-B1', '-x', '--', dir], {
    timeout: DU_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const bytes = Number.parseInt(stdout.trim().split(/\s/, 1)[0] ?? '', 10);
  if (!Number.isSafeInteger(bytes)) throw new Error(`du printed ${JSON.stringify(stdout)}`);
  return bytes;
}

export interface DiskResult {
  checked: number;
  /** Copies over the limit after this run. */
  over: string[];
  /** Copies whose folder could not be measured (e.g. missing). */
  failed: string[];
}

/**
 * Measures every copy folder and stores its size; flags the ones over 5 GB (Docker can't
 * limit disk use on this filesystem). Logs when a copy goes over the limit or back under it.
 */
export async function checkCopySizes(options: HousekeepingOptions = {}): Promise<DiskResult> {
  const limit = options.diskLimitBytes ?? DISK_LIMIT_BYTES;
  const copies = await prisma.copy.findMany({
    where: options.copyIds ? { id: { in: options.copyIds } } : {},
    select: { id: true, projectId: true, overDiskLimit: true },
  });
  const result: DiskResult = { checked: 0, over: [], failed: [] };
  for (const copy of copies) {
    let bytes: number;
    try {
      bytes = await folderDiskBytes(copyDir(copy.projectId, copy.id));
    } catch (err) {
      result.failed.push(copy.id);
      console.error(
        `Could not measure copy ${copy.id}:`,
        err instanceof Error ? err.message.split('\n', 1)[0] : err,
      );
      continue;
    }
    const over = bytes > limit;
    await prisma.copy.updateMany({
      where: { id: copy.id },
      data: { diskBytes: BigInt(bytes), diskCheckedAt: new Date(), overDiskLimit: over },
    });
    result.checked++;
    if (over) result.over.push(copy.id);
    const gb = (bytes / 1024 ** 3).toFixed(2);
    if (over && !copy.overDiskLimit) {
      console.warn(`Copy ${copy.id} is over the disk limit: ${gb} GB (limit ${limit} bytes)`);
    } else if (!over && copy.overDiskLimit) {
      console.log(`Copy ${copy.id} is back under the disk limit: ${gb} GB`);
    }
  }
  return result;
}

/**
 * One housekeeping run: idle IDEs first, then disk use, then (Phase 7) copies of automatic-mode
 * projects that are still behind main.
 */
export async function runHousekeeping(
  options: HousekeepingOptions = {},
): Promise<{ idle: IdleResult; disk: DiskResult; updates: ProjectUpdateResult }> {
  const idle = await stopIdleIdes(options);
  const disk = await checkCopySizes(options);
  const updates = await retryBehindCopies({ copyIds: options.copyIds });
  return { idle, disk, updates };
}
