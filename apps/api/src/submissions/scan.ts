import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  MAX_SCANNED_FILES,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_FILE_BYTES,
  type FileChange,
} from '@devspace/shared';
import { listAllFiles, type FlatTreeEntry } from '../git/repo.ts';
import { HttpError } from '../lib/http-error.ts';

/**
 * Reading a member's copy folder. Everything in it is untrusted: the member controls every
 * file, including `.git/` and symlinks. So nothing here runs git inside the copy; every entry is
 * `lstat`ed, symlinks are never followed (a symlink is read as its target text), `.git` is
 * skipped, and every path is checked to stay inside the copy. Files are opened with
 * O_NOFOLLOW and checked against the scan's inode, so a file swapped for a link (or moved
 * under a swapped folder) after the scan is refused instead of read.
 */

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_GITIGNORE_BYTES = 1024 * 1024;

export type FileMode = '100644' | '100755' | '120000';

export interface DiskEntry {
  path: string;
  mode: FileMode;
  /** Bytes (for a symlink, the length of its target text). */
  size: number;
  dev: number;
  ino: number;
}

export const tooLarge = (message: string, details?: Record<string, unknown>) =>
  new HttpError(409, 'submission_too_large', message, undefined, details);

/** Names we never read: `.git` in any case, and names a repository path can't hold. */
function skipName(name: string): boolean {
  if (name.toLowerCase() === '.git') return true;
  return [...name].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch === '\u007f');
}

/** The absolute path of `rel` inside `root`, or throws if it would leave the root. */
export function insideCopy(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (rel === '' || !abs.startsWith(base + sep)) {
    throw new HttpError(400, 'validation_error', 'Invalid path');
  }
  return abs;
}

function modeOf(st: Stats): FileMode | null {
  if (st.isSymbolicLink()) return '120000';
  if (st.isFile()) return st.mode & 0o100 ? '100755' : '100644';
  return null;
}

interface Rules {
  /** The folder the .gitignore sits in ('' for the root). */
  base: string;
  ig: Ignore;
}

/** Reads a folder's `.gitignore` if it is a regular file (never through a link). */
async function loadRules(root: string, dir: string): Promise<Rules | null> {
  const rel = dir === '' ? '.gitignore' : `${dir}/.gitignore`;
  const abs = insideCopy(root, rel);
  let st: Stats;
  try {
    st = await lstat(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_GITIGNORE_BYTES) return null;
  const text = await readRegularFile(abs, st, MAX_GITIGNORE_BYTES).catch(() => null);
  if (text === null) return null;
  return { base: dir, ig: ignore().add(text.toString('utf8')) };
}

/** Git's rule: the deepest .gitignore that says anything about the path wins. */
function isIgnored(rules: readonly Rules[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const { base, ig } of rules) {
    const local = base === '' ? rel : rel.slice(base.length + 1);
    const result = ig.test(isDir ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

export interface ScanOptions {
  /** Paths tracked in the base commit: never treated as ignored. */
  tracked: ReadonlySet<string>;
  /** Every folder that holds a tracked path (searched even if ignored). */
  trackedDirs: ReadonlySet<string>;
  /** Submodule paths in the base commit: never read. */
  skip: ReadonlySet<string>;
}

/**
 * Lists the copy's regular files and symlinks (not ignored, `.git` skipped, links not
 * followed), up to MAX_SCANNED_FILES (then 409 `submission_too_large`).
 */
export async function scanCopy(
  root: string,
  options: ScanOptions,
): Promise<Map<string, DiskEntry>> {
  const found = new Map<string, DiskEntry>();
  const stack: { dir: string; rules: Rules[] }[] = [{ dir: '', rules: [] }];
  while (stack.length > 0) {
    const { dir, rules: parentRules } = stack.pop()!;
    const abs = dir === '' ? resolve(root) : insideCopy(root, dir);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      continue; // removed meanwhile, or not readable
    }
    const own = await loadRules(root, dir);
    const rules = own ? [...parentRules, own] : parentRules;
    for (const name of names.sort()) {
      if (skipName(name)) continue;
      const rel = dir === '' ? name : `${dir}/${name}`;
      if (options.skip.has(rel)) continue;
      let st: Stats;
      try {
        st = await lstat(insideCopy(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (isIgnored(rules, rel, true) && !options.trackedDirs.has(rel)) continue;
        stack.push({ dir: rel, rules });
        continue;
      }
      const mode = modeOf(st);
      if (!mode) continue; // sockets, pipes, devices
      if (isIgnored(rules, rel, false) && !options.tracked.has(rel)) continue;
      found.set(rel, { path: rel, mode, size: st.size, dev: st.dev, ino: st.ino });
      if (found.size > MAX_SCANNED_FILES) {
        throw tooLarge(
          `Your copy has more than ${MAX_SCANNED_FILES} files (not counting ignored ones)`,
        );
      }
    }
  }
  return found;
}

/**
 * Reads a regular file without following a link at its last step, and only if it is still the
 * file `expected` describes (same device and inode), so nothing outside the copy is ever read.
 */
async function readRegularFile(abs: string, expected: Stats | DiskEntry, maxBytes: number) {
  const handle = await open(abs, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) {
      throw new Error('file changed while reading');
    }
    if (st.size > maxBytes) throw new Error('file too large');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The bytes git stores for a scanned entry: file contents, or a symlink's target text. */
export async function readEntry(root: string, entry: DiskEntry, maxBytes: number): Promise<Buffer> {
  const abs = insideCopy(root, entry.path);
  if (entry.mode === '120000') {
    const st = await lstat(abs);
    if (!st.isSymbolicLink() || st.ino !== entry.ino || st.dev !== entry.dev) {
      throw new Error('link changed while reading');
    }
    const target = await readlink(abs, { encoding: 'buffer' });
    if (target.length > maxBytes) throw new Error('link too long');
    return target;
  }
  const bytes = await readRegularFile(abs, entry, maxBytes);
  if (bytes.length > maxBytes) throw new Error('file too large');
  return bytes;
}

/** The id git gives `content` as a blob (SHA-1, or SHA-256 for repositories that use it). */
export function blobId(content: Buffer, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
}

export interface CopyChange {
  path: string;
  change: FileChange;
  /** Present unless deleted. */
  disk?: DiskEntry;
}

function parentsOf(path: string): string[] {
  const parts = path.split('/');
  const result: string[] = [];
  for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
  return result;
}

/**
 * The copy's working tree compared with `baseSha`'s tree in the project's bare repository:
 * added, modified (different content or mode) and deleted files, sorted by path.
 */
export async function diffCopy(
  gitDir: string,
  baseSha: string,
  root: string,
): Promise<Map<string, CopyChange>> {
  const baseEntries = await listAllFiles(gitDir, baseSha);
  const base = new Map<string, FlatTreeEntry>();
  const skip = new Set<string>();
  const trackedDirs = new Set<string>();
  for (const entry of baseEntries) {
    if (entry.mode === '160000') skip.add(entry.path);
    else base.set(entry.path, entry);
    for (const parent of parentsOf(entry.path)) trackedDirs.add(parent);
  }
  const disk = await scanCopy(root, { tracked: new Set(base.keys()), trackedDirs, skip });
  const algorithm = baseSha.length === 64 ? 'sha256' : 'sha1';

  const changes = new Map<string, CopyChange>();
  for (const entry of disk.values()) {
    const before = base.get(entry.path);
    if (!before) {
      changes.set(entry.path, { path: entry.path, change: 'added', disk: entry });
      continue;
    }
    let same = before.mode === entry.mode && before.size === entry.size;
    if (same) {
      try {
        const bytes = await readEntry(root, entry, Math.max(entry.size, 0));
        same = blobId(bytes, algorithm) === before.sha;
      } catch {
        same = false; // changed while scanning: report it; submitting re-reads it
      }
    }
    if (!same) changes.set(entry.path, { path: entry.path, change: 'modified', disk: entry });
  }
  for (const path of base.keys()) {
    if (!disk.has(path)) changes.set(path, { path, change: 'deleted' });
  }
  return new Map([...changes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Reads the chosen changed files for a snapshot, enforcing the per-file and total limits. */
export async function readChosen(
  root: string,
  chosen: readonly CopyChange[],
): Promise<Map<string, Buffer>> {
  const tooBig = chosen.filter((c) => c.disk && c.disk.size > MAX_SUBMISSION_FILE_BYTES);
  if (tooBig.length > 0) {
    throw tooLarge('Files over 10 MB can’t be submitted', { paths: tooBig.map((c) => c.path) });
  }
  const total = chosen.reduce((sum, c) => sum + (c.disk?.size ?? 0), 0);
  if (total > MAX_SUBMISSION_BYTES) throw tooLarge('A submission can hold at most 100 MB');
  const contents = new Map<string, Buffer>();
  let read = 0;
  for (const change of chosen) {
    if (!change.disk) continue;
    let bytes: Buffer;
    try {
      bytes = await readEntry(root, change.disk, MAX_SUBMISSION_FILE_BYTES);
    } catch {
      throw new HttpError(
        409,
        'copy_changed',
        `${change.path} changed while it was being read; try again`,
      );
    }
    read += bytes.length;
    if (read > MAX_SUBMISSION_BYTES) throw tooLarge('A submission can hold at most 100 MB');
    contents.set(change.path, bytes);
  }
  return contents;
}

/**
 * Opens a regular file in the copy for reading and writing (suggestion accept): the path must
 * stay inside the copy, every folder on the way must be a real folder (no links), and the file
 * itself must be a regular file (O_NOFOLLOW). Returns null if it isn't.
 */
export async function openCopyFileForWrite(root: string, rel: string) {
  const abs = insideCopy(root, rel);
  const realRoot = await realpath(root);
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(abs));
  } catch {
    return null;
  }
  // A link anywhere in the folders makes the real path differ from the plain one.
  const expectedParent = resolve(realRoot, dirname(rel));
  if (parentReal !== expectedParent || rel.split('/').some((p) => p.toLowerCase() === '.git')) {
    return null;
  }
  let handle;
  try {
    handle = await open(join(parentReal, rel.split('/').pop()!), constants.O_RDWR | O_NOFOLLOW);
  } catch {
    return null;
  }
  // A folder could be swapped for a link between the check above and open(), so check where
  // the opened file really is (Linux: /proc/self/fd) before anything is written to it.
  const st = await handle.stat();
  const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (!st.isFile() || opened === null || !opened.startsWith(realRoot + sep)) {
    await handle.close();
    return null;
  }
  return handle;
}
