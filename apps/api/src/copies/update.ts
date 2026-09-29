import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordActivity } from '../activity/log.ts';
import {
  byPath,
  changedPaths,
  deleteRef,
  isAncestor,
  listAllFiles,
  MAIN_REF,
  mergeTree,
  parentOf,
  readBlob,
  resolveCommit,
  treeWithChanges,
  updateRef,
  writeBlob,
  writeCommit,
  type FlatTreeEntry,
  type IndexChange,
} from '../git/repo.ts';
import { HttpError } from '../lib/http-error.ts';
import { notify, pathsData } from '../notifications/service.ts';
import { invalidateAfterCommit } from '../realtime/emitter.ts';
import { prisma } from '../lib/prisma.ts';
import { withProjectLock, type Tx } from '../merge/lock.ts';
import { readSettings } from '../projects/access.ts';
import { removeDir } from '../repository/storage.ts';
import { diffCopy, isDevspacePath, readChosen } from '../submissions/scan.ts';
import {
  CopyChangedError,
  diskEntry,
  diskMatches,
  removeEntry,
  safeParts,
  writeEntry,
  type EntryMode,
  type GitEntry,
} from './safe-fs.ts';
import { copyBaseSha, copyDir } from './service.ts';

/**
 * Bringing main's new commits into a member's copy (Phase 7). Everything is built in the
 * project's bare repository; git never runs in the copy, and its `.git` is never touched.
 *
 * 1. Snapshot the whole working tree as commit W: the tree of `copy.baseSha` plus every current
 *    change (Phase 6's scanner, limits and `--no-filters` blobs).
 * 2. `merge-tree --merge-base=<copy.baseSha> W main` → tree R and the conflicted paths. Text
 *    conflicts carry markers, relabelled `<<<<<<< your copy` / `>>>>>>> main`; for any other
 *    conflict (modify/delete, binary, …) the member's version is kept.
 * 3. For the author of a submission reverted since the copy's base, the paths that revert
 *    changed keep W's version ("back as changes").
 * 4. Every path where the result differs from W is written into the copy, each only after
 *    checking the disk still holds W's version (else 409 `copy_changed`, and whatever was
 *    written is put back). Then `copy.baseSha = main`.
 */

const SNAPSHOT_IDENTITY = { name: 'DevSpace', email: 'devspace@localhost' };
/** Conflicted files larger than this are kept as the member's version (no markers). */
const MAX_MARKER_FILE_BYTES = 10 * 1024 * 1024;

export const copyChanged = (path?: string) =>
  new HttpError(
    409,
    'copy_changed',
    path
      ? `${path} changed in your copy while updating; nothing was changed, try again`
      : 'Your copy changed while updating; nothing was changed, try again',
  );
const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");

interface Entry extends GitEntry {
  size: number;
}

export interface CopyRow {
  id: string;
  projectId: string;
  userId: string;
  baseSha: string | null;
}

interface Write {
  path: string;
  from: Entry | null;
  to: Entry | null;
}

export interface UpdatePlan {
  main: string;
  /** `package.json` / `package-lock.json` files main changed since the copy's base (Phase 9). */
  packagePaths?: string[];
  base: string;
  behind: boolean;
  /** Every file that conflicted (with markers, or kept as the member's version). Sorted. */
  conflictPaths: string[];
  /** The conflicted text files the result gives markers. Sorted. */
  markerPaths: string[];
  writes: Write[];
  algorithm: 'sha1' | 'sha256';
}

function entryMap(entries: readonly FlatTreeEntry[]): Map<string, Entry> {
  return new Map(entries.map((e) => [e.path, { mode: e.mode, sha: e.sha, size: e.size ?? 0 }]));
}

function sameEntry(a: GitEntry | null | undefined, b: GitEntry | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.mode === b.mode && a.sha === b.sha;
}

/** The copy's whole working tree as a commit on top of `base` (not on any branch). */
async function snapshotCopy(gitDir: string, base: string, root: string): Promise<string> {
  const changes = [...(await diffCopy(gitDir, base, root)).values()];
  if (changes.length === 0) return base;
  const contents = await readChosen(root, changes);
  const index: IndexChange[] = [];
  for (const change of changes) {
    const bytes = contents.get(change.path);
    index.push({
      path: change.path,
      entry:
        change.disk && bytes
          ? { mode: change.disk.mode, sha: await writeBlob(gitDir, bytes) }
          : null,
    });
  }
  const temp = await mkdtemp(join(tmpdir(), 'devspace-index-'));
  try {
    const tree = await treeWithChanges(gitDir, base, index, join(temp, 'index'));
    return await writeCommit(
      gitDir,
      tree,
      [base],
      'DevSpace: snapshot of a copy before an update\n',
      SNAPSHOT_IDENTITY,
    );
  } finally {
    await removeDir(temp).catch(() => undefined);
  }
}

/**
 * The paths that should stay as the member has them because they authored a submission that
 * was reverted after the copy's base (the revert commit is in main but not in the base).
 */
async function revertedPathsFor(
  gitDir: string,
  copy: CopyRow,
  base: string,
  main: string,
): Promise<Set<string>> {
  const reverted = await prisma.submission.findMany({
    where: {
      projectId: copy.projectId,
      authorId: copy.userId,
      status: 'reverted',
      revertedSha: { not: null },
    },
    select: { revertedSha: true },
  });
  const keep = new Set<string>();
  for (const { revertedSha } of reverted) {
    const sha = revertedSha!;
    if (!(await resolveCommit(gitDir, sha))) continue;
    if (!(await isAncestor(gitDir, sha, main)) || (await isAncestor(gitDir, sha, base))) continue;
    const parent = await parentOf(gitDir, sha);
    if (!parent) continue;
    for (const path of await changedPaths(gitDir, parent, sha)) keep.add(path);
  }
  return keep;
}

/** Replaces the merge's temporary labels on marker lines with `your copy` and `main`. */
function relabel(text: string, yours: string, theirs: string): string {
  return text
    .split(`<<<<<<< ${yours}`)
    .join('<<<<<<< your copy')
    .split(`>>>>>>> ${theirs}`)
    .join('>>>>>>> main');
}

/** Works out what updating the copy to the current main would do (writes nothing to the copy). */
export async function planUpdate(gitDir: string, copy: CopyRow): Promise<UpdatePlan> {
  const main = await resolveCommit(gitDir, MAIN_REF);
  if (!main) throw notReady();
  const base = await copyBaseSha(copy, gitDir);
  const algorithm = main.length === 64 ? 'sha256' : 'sha1';
  if (base === main) {
    return { main, base, behind: false, conflictPaths: [], markerPaths: [], writes: [], algorithm };
  }

  const root = copyDir(copy.projectId, copy.id);
  // A missing folder must never read as "every file deleted" (e.g. a process with another
  // COPIES_DIR): refuse instead.
  const folder = await lstat(root).catch(() => null);
  if (!folder?.isDirectory()) {
    throw new HttpError(409, 'no_copy', "This copy's folder is missing on the server");
  }
  const w = await snapshotCopy(gitDir, base, root);

  // Temporary refs, so the conflict markers carry names we can find and relabel.
  const tag = randomUUID();
  const yours = `refs/devspace/update/${tag}/yours`;
  const theirs = `refs/devspace/update/${tag}/main`;
  await updateRef(gitDir, yours, w);
  await updateRef(gitDir, theirs, main);
  let merged;
  try {
    merged = await mergeTree(gitDir, base, yours, theirs);
  } finally {
    await deleteRef(gitDir, yours).catch(() => undefined);
    await deleteRef(gitDir, theirs).catch(() => undefined);
  }

  const wFiles = entryMap(await listAllFiles(gitDir, w));
  const rFiles = entryMap(await listAllFiles(gitDir, merged.tree));
  const final = new Map(rFiles);
  // File/folder clashes make git add a side copy named `<path>~<label>`: never write those;
  // the member's own version stays at `<path>` (handled as a conflict below).
  // (git writes the label with `/` as `_`; the random tag finds it either way.)
  const originalOf = (path: string): string | null => {
    const at = path.indexOf(tag);
    if (at < 0) return null;
    const tilde = path.lastIndexOf('~', at);
    return tilde > 0 ? path.slice(0, tilde) : null;
  };
  const movedAside = new Set<string>();
  for (const path of [...final.keys()]) {
    const original = originalOf(path);
    if (original === null && !path.includes(tag)) continue;
    final.delete(path);
    if (original) movedAside.add(original);
  }
  const keepMine = (path: string) => {
    const mine = wFiles.get(path);
    if (mine) final.set(path, mine);
    else final.delete(path);
  };

  const keep = await revertedPathsFor(gitDir, copy, base, main);
  const conflicts = new Set<string>();
  const markers: string[] = [];
  const conflicted = new Set([...merged.conflicts.filter((p) => !p.includes(tag)), ...movedAside]);
  for (const path of [...conflicted].sort(byPath)) {
    if (keep.has(path)) continue;
    const result = rFiles.get(path);
    if (
      result &&
      result.mode !== '120000' &&
      result.mode !== '160000' &&
      result.size <= MAX_MARKER_FILE_BYTES
    ) {
      const text = (await readBlob(gitDir, result.sha, Math.max(result.size, 1))).toString(
        'latin1',
      );
      if (text.includes(`<<<<<<< ${yours}`)) {
        const bytes = Buffer.from(relabel(text, yours, theirs), 'latin1');
        final.set(path, {
          mode: result.mode,
          sha: await writeBlob(gitDir, bytes),
          size: bytes.length,
        });
        markers.push(path);
        conflicts.add(path);
        continue;
      }
    }
    keepMine(path); // modify/delete, binary, links and anything else: the member's version
    conflicts.add(path);
  }
  for (const path of keep) keepMine(path);
  // A folder the member replaced with a file or link: nothing from main goes below it (their
  // version wins; writing there would mean going through the link).
  for (const path of [...final.keys()]) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (wFiles.has(parent) && final.has(parent)) {
        keepMine(path);
        conflicts.add(path);
        break;
      }
    }
  }

  const writes: Write[] = [];
  const paths = [...new Set([...wFiles.keys(), ...final.keys()])].sort(byPath);
  for (const path of paths) {
    const from = wFiles.get(path) ?? null;
    const to = final.get(path) ?? null;
    if (sameEntry(from, to)) continue;
    if (from?.mode === '160000' || to?.mode === '160000') continue; // never submodules
    if (!safeParts(path)) continue; // never `.git`, `.` or `..`
    if (isDevspacePath(path)) continue; // never DevSpace's own folder (Phase 10)
    if (from === null) {
      // Something ignored may already sit there: the member's file wins.
      const onDisk = await diskEntry(root, path, algorithm).catch(() => 'other' as const);
      if (onDisk !== null) {
        if (!sameEntry(onDisk === 'other' ? null : onDisk, to)) conflicts.add(path);
        continue;
      }
    }
    writes.push({ path, from, to });
  }

  return {
    main,
    base,
    behind: true,
    conflictPaths: [...conflicts].sort(byPath),
    markerPaths: markers.filter((p) => writes.some((w) => w.path === p)).sort(byPath),
    writes,
    algorithm,
  };
}

async function put(gitDir: string, root: string, path: string, entry: Entry | null): Promise<void> {
  if (!entry) {
    await removeEntry(root, path);
    return;
  }
  const bytes = await readBlob(gitDir, entry.sha, Math.max(entry.size, 1));
  await writeEntry(root, path, entry.mode as EntryMode, bytes);
}

/**
 * Writes a plan into the copy. Every path is checked first (the disk must still hold W's
 * version); then each is checked again right before it is written. On any failure, what was
 * already written is put back, so nothing is left half-updated.
 */
export async function applyPlan(gitDir: string, root: string, plan: UpdatePlan): Promise<void> {
  for (const write of plan.writes) {
    if (!(await diskMatches(root, write.path, write.from, plan.algorithm))) {
      throw copyChanged(write.path);
    }
  }
  const done: Write[] = [];
  try {
    for (const write of plan.writes) {
      if (!(await diskMatches(root, write.path, write.from, plan.algorithm))) {
        throw new CopyChangedError(write.path);
      }
      await put(gitDir, root, write.path, write.to);
      done.push(write);
    }
  } catch (err) {
    for (const write of done.reverse()) {
      await put(gitDir, root, write.path, write.from).catch((undoErr: unknown) =>
        console.error(
          `Could not put back ${write.path} after a failed copy update:`,
          undoErr instanceof Error ? undoErr.message : undoErr,
        ),
      );
    }
    if (err instanceof CopyChangedError) throw copyChanged(err.path);
    throw err;
  }
}

export type CopyUpdateOutcome =
  | { kind: 'up_to_date' }
  | { kind: 'updated'; conflictPaths: string[]; markerPaths: string[] }
  /** Automatic mode with conflicts: the copy was left untouched. */
  | { kind: 'pending'; conflictPaths: string[] };

const copyRowSelect = {
  id: true,
  projectId: true,
  userId: true,
  baseSha: true,
  markerPaths: true,
  pendingConflictPaths: true,
} as const;

/**
 * Updates one copy to the current main under the project lock (and the copy's submission lock).
 * `manual`: applies even with conflicts (markers). `automatic`: applies only a clean result;
 * with conflicts the copy is left untouched and `pendingConflictPaths` is stored.
 * Throws 409 `copy_changed` if the copy changed while updating.
 */
export async function updateCopy(
  gitDir: string,
  copyId: string,
  projectId: string,
  mode: 'manual' | 'automatic',
  actorId: string | null,
): Promise<CopyUpdateOutcome> {
  return withProjectLock(
    projectId,
    async (tx) => {
      const row = await tx.copy.findUnique({ where: { id: copyId }, select: copyRowSelect });
      if (!row) throw new HttpError(409, 'no_copy', 'There is no copy to update');
      const plan = await planUpdate(gitDir, row);
      if (!plan.behind) {
        if (row.pendingConflictPaths.length > 0) {
          await tx.copy.update({ where: { id: row.id }, data: { pendingConflictPaths: [] } });
          await invalidateAfterCommit(tx, row.projectId, [`copy:${row.userId}`]);
        }
        return { kind: 'up_to_date' };
      }
      if (mode === 'automatic' && plan.conflictPaths.length > 0) {
        await tx.copy.update({
          where: { id: row.id },
          data: { pendingConflictPaths: plan.conflictPaths },
        });
        // Told once per new set of conflicts (housekeeping retries every minute).
        if (!samePaths(row.pendingConflictPaths, plan.conflictPaths)) {
          await notify(tx, {
            type: 'copy.update_conflicts',
            projectId: row.projectId,
            userIds: [row.userId],
            actorId: actorId,
            data: pathsData(plan.conflictPaths),
          });
          await invalidateAfterCommit(tx, row.projectId, [`copy:${row.userId}`]);
        }
        return { kind: 'pending', conflictPaths: plan.conflictPaths };
      }
      plan.packagePaths = await packageChanges(gitDir, plan.base, plan.main);
      const markerPaths = [...new Set([...row.markerPaths, ...plan.markerPaths])].sort(byPath);
      // The row first: if writing the files fails, the transaction rolls it back.
      await recordUpdate(tx, row, plan, markerPaths, mode, actorId);
      await applyPlan(gitDir, copyDir(row.projectId, row.id), plan);
      return {
        kind: 'updated',
        conflictPaths: plan.conflictPaths,
        markerPaths: plan.markerPaths,
      };
    },
    { copyId },
  );
}

async function recordUpdate(
  tx: Tx,
  row: { id: string; projectId: string; userId: string; baseSha: string | null },
  plan: UpdatePlan,
  markerPaths: string[],
  mode: 'manual' | 'automatic',
  actorId: string | null,
): Promise<void> {
  const { count } = await tx.copy.updateMany({
    where: { id: row.id, OR: [{ baseSha: plan.base }, { baseSha: null }] },
    data: {
      baseSha: plan.main,
      markerPaths,
      pendingConflictPaths: [],
      ...(plan.packagePaths?.length ? { packagesChangedAt: new Date() } : {}),
    },
  });
  if (count !== 1) throw copyChanged();
  if (plan.packagePaths?.length) {
    // The owner updating by hand is the one who did it: the banner shows, no notification.
    await notify(tx, {
      type: 'copy.packages_changed',
      projectId: row.projectId,
      userIds: [row.userId],
      actorId,
      data: pathsData(plan.packagePaths),
    });
  }
  await recordActivity(tx, {
    projectId: row.projectId,
    actorId,
    action: 'copy.updated',
    target: row.userId,
    data: {
      mainSha: plan.main,
      conflictPaths: plan.conflictPaths,
      automatic: mode === 'automatic',
    },
  });
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...a].sort(byPath);
  return [...b].sort(byPath).every((path, i) => path === sorted[i]);
}

const PACKAGE_FILES = new Set(['package.json', 'package-lock.json']);

/** The `package.json` / `package-lock.json` files (at any depth) that differ between two commits. */
export async function packageChanges(gitDir: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const paths = await changedPaths(gitDir, from, to);
  return paths.filter((path) => PACKAGE_FILES.has(path.slice(path.lastIndexOf('/') + 1)));
}

// ---------- The owner's routes ----------

const noCopy = () =>
  new HttpError(409, 'no_copy', "You don't have a copy of this project yet; open the IDE first");

async function myCopyRow(projectId: string, userId: string) {
  const row = await prisma.copy.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { id: true, projectId: true, userId: true, baseSha: true },
  });
  if (!row) throw noCopy();
  return row;
}

/** GET /copy/update — what updating now would do, computed live (writes nothing to the copy). */
export async function previewMyUpdate(
  gitDir: string,
  projectId: string,
  userId: string,
): Promise<{ behind: boolean; conflictPaths: string[] }> {
  const plan = await planUpdate(gitDir, await myCopyRow(projectId, userId));
  return { behind: plan.behind, conflictPaths: plan.conflictPaths };
}

/** POST /copy/update — applies the update even with conflicts (markers). */
export async function updateMyCopy(
  gitDir: string,
  projectId: string,
  userId: string,
): Promise<{ conflictPaths: string[] }> {
  const row = await myCopyRow(projectId, userId);
  const outcome = await updateCopy(gitDir, row.id, projectId, 'manual', userId);
  return { conflictPaths: outcome.kind === 'updated' ? outcome.conflictPaths : [] };
}

// ---------- Automatic mode ----------

export interface ProjectUpdateResult {
  updated: string[];
  pending: string[];
  upToDate: string[];
  /** Copies that changed while updating, or failed: retried on the next run. */
  failed: string[];
}

/**
 * Automatic mode: brings every copy of the project (or just `copyIds`) up to date with main.
 * The worker runs this after a merge or revert, and housekeeping retries copies still behind.
 * Does nothing when the project updates copies manually.
 */
export async function updateProjectCopies(
  projectId: string,
  options: { copyIds?: string[] } = {},
): Promise<ProjectUpdateResult> {
  const result: ProjectUpdateResult = { updated: [], pending: [], upToDate: [], failed: [] };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repoPath: true, repoStatus: true, settings: true },
  });
  if (!project?.repoPath || project.repoStatus !== 'ready') return result;
  if (readSettings(project.settings).copyUpdateMode !== 'automatic') return result;
  const gitDir = project.repoPath;
  const main = await resolveCommit(gitDir, MAIN_REF);
  if (!main) return result;
  const copies = await prisma.copy.findMany({
    where: { projectId, ...(options.copyIds ? { id: { in: options.copyIds } } : {}) },
    select: { id: true, baseSha: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const copy of copies) {
    if (copy.baseSha === main) {
      result.upToDate.push(copy.id);
      continue;
    }
    try {
      const outcome = await updateCopy(gitDir, copy.id, projectId, 'automatic', null);
      if (outcome.kind === 'updated') result.updated.push(copy.id);
      else if (outcome.kind === 'pending') result.pending.push(copy.id);
      else result.upToDate.push(copy.id);
    } catch (err) {
      result.failed.push(copy.id);
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Copy ${copy.id} was not updated (retried later): ${message}`);
    }
  }
  return result;
}

/**
 * Housekeeping: every project that updates copies automatically gets its copies that are
 * still behind main updated (a copy that changed mid-update, or a job that never ran).
 */
export async function retryBehindCopies(
  options: { copyIds?: string[] } = {},
): Promise<ProjectUpdateResult> {
  const total: ProjectUpdateResult = { updated: [], pending: [], upToDate: [], failed: [] };
  const projects = await prisma.project.findMany({
    where: {
      repoStatus: 'ready',
      repoPath: { not: null },
      ...(options.copyIds ? { copies: { some: { id: { in: options.copyIds } } } } : {}),
    },
    select: { id: true },
  });
  for (const { id } of projects) {
    try {
      const one = await updateProjectCopies(id, options);
      for (const key of ['updated', 'pending', 'upToDate', 'failed'] as const) {
        total[key].push(...one[key]);
      }
    } catch (err) {
      console.error(
        `Could not update the copies of project ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return total;
}
