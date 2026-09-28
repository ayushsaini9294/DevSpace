import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { blobId } from '../submissions/scan.ts';

/**
 * Reading and writing single files in a member's copy folder (Phase 7 copy updates), which is
 * untrusted: the member controls every file, folder and link in it. The rules:
 * - never follow a symlink: every folder on the way is opened one component at a time with
 *   O_DIRECTORY | O_NOFOLLOW through the previous folder's descriptor (`/proc/self/fd/<fd>/…`,
 *   Linux's equivalent of openat), so a folder swapped for a link is refused, not followed;
 * - every opened folder and file is checked to really be where we expect via /proc/self/fd;
 * - nothing is ever read or written under `.git` (any case), `.` or `..`.
 * A problem that means "the copy changed under us" throws CopyChangedError.
 */

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

export class CopyChangedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed in the copy`);
    this.name = 'CopyChangedError';
  }
}

export type EntryMode = '100644' | '100755' | '120000';

export interface GitEntry {
  mode: string;
  sha: string;
}

/** The path's components, or null if it must never be touched. */
export function safeParts(rel: string): string[] | null {
  const parts = rel.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') return null;
    if (part.includes('\0')) return null;
  }
  return parts;
}

const fdPath = (fd: number, name?: string) =>
  name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Opens the folder made of `parts` inside the copy without following any link. Missing folders
 * are created when `create` is true; otherwise null is returned for a missing one. A component
 * that exists but isn't a real folder throws CopyChangedError.
 */
async function openFolder(
  root: string,
  parts: readonly string[],
  create: boolean,
  rel: string,
): Promise<{ dir: FileHandle; realRoot: string } | null> {
  const realRoot = await realpath(root);
  let dir = await open(realRoot, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    for (const part of parts) {
      const next = fdPath(dir.fd, part);
      let handle: FileHandle;
      try {
        handle = await open(next, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (err) {
        if (code(err) !== 'ENOENT') throw new CopyChangedError(rel); // a link, a file, …
        if (!create) {
          await dir.close();
          return null;
        }
        try {
          await mkdir(next, { mode: 0o755 });
        } catch (mkErr) {
          if (code(mkErr) !== 'EEXIST') throw mkErr;
        }
        try {
          handle = await open(next, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch {
          throw new CopyChangedError(rel);
        }
      }
      await dir.close();
      dir = handle;
    }
    const where = await readlink(fdPath(dir.fd));
    if (where !== join(realRoot, ...parts)) throw new CopyChangedError(rel);
    return { dir, realRoot };
  } catch (err) {
    await dir.close().catch(() => undefined);
    throw err;
  }
}

async function withParent<T>(
  root: string,
  rel: string,
  create: boolean,
  fn: (dir: FileHandle, name: string, realRoot: string) => Promise<T>,
  missing: () => T,
): Promise<T> {
  const parts = safeParts(rel);
  if (!parts) throw new CopyChangedError(rel);
  const name = parts.pop()!;
  const opened = await openFolder(root, parts, create, rel);
  if (!opened) return missing();
  try {
    return await fn(opened.dir, name, opened.realRoot);
  } finally {
    await opened.dir.close();
  }
}

/** What is on disk at `rel`, as a git entry (null when nothing is there). */
export type DiskState = GitEntry | null | 'other';

/**
 * The git entry the file at `rel` would be (mode and blob id), without following links; null
 * if nothing is there; `other` for a folder or anything that isn't a file or link.
 */
export async function diskEntry(
  root: string,
  rel: string,
  algorithm: 'sha1' | 'sha256',
): Promise<DiskState> {
  return withParent(
    root,
    rel,
    false,
    async (dir, name) => {
      const path = fdPath(dir.fd, name);
      let st;
      try {
        st = await lstat(path);
      } catch (err) {
        if (code(err) === 'ENOENT') return null;
        throw err;
      }
      if (st.isSymbolicLink()) {
        const target = await readlink(path, { encoding: 'buffer' });
        return { mode: '120000', sha: blobId(target, algorithm) };
      }
      if (!st.isFile()) return 'other';
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
      } catch {
        return 'other';
      }
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== st.ino) return 'other';
        const bytes = await handle.readFile();
        return { mode: opened.mode & 0o100 ? '100755' : '100644', sha: blobId(bytes, algorithm) };
      } finally {
        await handle.close();
      }
    },
    () => null,
  );
}

/** Does the disk hold exactly `expected` (null = nothing) at `rel`? */
export async function diskMatches(
  root: string,
  rel: string,
  expected: GitEntry | null,
  algorithm: 'sha1' | 'sha256',
): Promise<boolean> {
  const state = await diskEntry(root, rel, algorithm).catch((err: unknown) => {
    if (err instanceof CopyChangedError) return 'other' as const;
    throw err;
  });
  if (expected === null) return state === null;
  if (state === null || state === 'other') return false;
  return state.mode === expected.mode && state.sha === expected.sha;
}

/**
 * Writes one entry at `rel`: a regular file (mode 100644 or 100755) or a symlink (120000, with
 * `content` as its target text). Creates missing folders as real folders. Whatever was at the
 * path (a file or a link, never a folder) is replaced; a link is removed, never followed.
 */
export async function writeEntry(
  root: string,
  rel: string,
  mode: EntryMode,
  content: Buffer,
): Promise<void> {
  await withParent(
    root,
    rel,
    true,
    async (dir, name, realRoot) => {
      const path = fdPath(dir.fd, name);
      let st = null;
      try {
        st = await lstat(path);
      } catch (err) {
        if (code(err) !== 'ENOENT') throw err;
      }
      if (st && !st.isFile() && !st.isSymbolicLink()) throw new CopyChangedError(rel);
      if (st && (st.isSymbolicLink() || mode === '120000')) await unlink(path);
      if (mode === '120000') {
        await symlink(content, path);
        return;
      }
      const perm = mode === '100755' ? 0o755 : 0o644;
      let handle: FileHandle;
      try {
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
          perm,
        );
      } catch {
        throw new CopyChangedError(rel);
      }
      try {
        const where = await readlink(fdPath(handle.fd));
        const stat = await handle.stat();
        if (!stat.isFile() || !where.startsWith(realRoot + sep) || where !== join(realRoot, rel)) {
          throw new CopyChangedError(rel);
        }
        await handle.write(content, 0, content.length, 0);
        await handle.chmod(perm);
      } finally {
        await handle.close();
      }
    },
    () => undefined,
  );
}

/** Removes the file or link at `rel` (never a folder, never through a link). */
export async function removeEntry(root: string, rel: string): Promise<void> {
  await withParent(
    root,
    rel,
    false,
    async (dir, name) => {
      const path = fdPath(dir.fd, name);
      let st;
      try {
        st = await lstat(path);
      } catch (err) {
        if (code(err) === 'ENOENT') return;
        throw err;
      }
      if (!st.isFile() && !st.isSymbolicLink()) throw new CopyChangedError(rel);
      await unlink(path);
    },
    () => undefined,
  );
}

/**
 * Reads a regular file at `rel` (never through a link), up to `maxBytes`; null if it is
 * missing, isn't a regular file, is larger, or sits behind a link.
 */
export async function readRegular(
  root: string,
  rel: string,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    return await withParent(
      root,
      rel,
      false,
      async (dir, name) => {
        let handle: FileHandle;
        try {
          handle = await open(fdPath(dir.fd, name), constants.O_RDONLY | O_NOFOLLOW);
        } catch {
          return null;
        }
        try {
          const st = await handle.stat();
          if (!st.isFile() || st.size > maxBytes) return null;
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      },
      () => null,
    );
  } catch (err) {
    if (err instanceof CopyChangedError) return null;
    throw err;
  }
}
