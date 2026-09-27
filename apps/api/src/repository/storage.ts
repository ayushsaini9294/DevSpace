import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.ts';

/** Where a project's bare repository lives: `<REPOS_DIR>/<projectId>.git`. */
export function repoDir(projectId: string): string {
  return join(env.REPOS_DIR, `${projectId}.git`);
}

/** The folder an import is built in, next to the final one (one import per project at a time). */
export function importTempDir(projectId: string): string {
  return join(env.REPOS_DIR, `${projectId}.git.importing`);
}

/** A fresh folder next to the final one, for building a new empty repository. */
export function newTempDir(projectId: string): string {
  return join(env.REPOS_DIR, `${projectId}.git.new-${randomUUID()}`);
}

export async function ensureReposDir(): Promise<void> {
  await mkdir(env.REPOS_DIR, { recursive: true });
}

/** Deletes a folder tree, retrying briefly (Windows can hold files for a moment after git exits). */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Moves a finished repository into place, replacing any stale folder already there. */
export async function moveIntoPlace(from: string, to: string): Promise<void> {
  await removeDir(to);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Total size in bytes of the files under `dir` (files that vanish mid-count are skipped). */
export async function folderSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        try {
          total += (await stat(join(e.parentPath, e.name))).size;
        } catch {
          // Renamed or deleted while counting (git moves pack files into place).
        }
      }),
  );
  return total;
}
