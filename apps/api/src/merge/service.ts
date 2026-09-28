import {
  ACTIVE_SUBMISSION_STATUSES,
  can,
  isActiveSubmissionStatus,
  type ProjectSettings,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import {
  casRef,
  mergeTree,
  parentOf,
  MAIN_REF,
  resolveCommit,
  treeOf,
  writeCommit,
  type Identity,
} from '../git/repo.ts';
import { GitError } from '../git/run.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { forbidden, readSettings, type ProjectAccess } from '../projects/access.ts';
import { reviewSelect, statusFromReviews } from '../submissions/status.ts';
import { queueCopyUpdates } from '../jobs/copy-updates.ts';
import { onSubmissionMerged, onSubmissionReverted } from '../tasks/automatic.ts';
import { withProjectLock, type Tx } from './lock.ts';

/**
 * Merge, revert and the conflict re-check (Phase 7). Everything happens in the project's bare
 * repository with `git merge-tree --write-tree`; nothing runs in a copy. All of it runs under
 * the project lock, and main moves only by compare-and-swap.
 */

const ACTIVE = [...ACTIVE_SUBMISSION_STATUSES];

export type Leader = Identity & { id: string };

const notFound = () => new HttpError(404, 'not_found', 'Submission not found');
const notActive = () =>
  new HttpError(409, 'submission_not_active', 'This submission is no longer open');
const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");
const mainMoved = () =>
  new HttpError(409, 'main_changed', 'Main changed while merging; please try again');

function gitDirOf(access: ProjectAccess): string {
  if (!access.project.repoPath) throw notReady();
  return access.project.repoPath;
}

async function currentMain(gitDir: string): Promise<string> {
  const main = await resolveCommit(gitDir, MAIN_REF);
  if (!main) throw notReady();
  return main;
}

/** Moves main from `old` to `next` (compare-and-swap); 409 `main_changed` if it moved. */
async function moveMain(gitDir: string, next: string, old: string): Promise<void> {
  try {
    await casRef(gitDir, MAIN_REF, next, old);
  } catch (err) {
    if (err instanceof GitError && err.kind === 'failed') throw mainMoved();
    throw err;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------- Conflict re-check ----------

/**
 * Runs merge-tree for every active submission of the project against `main` and stores the
 * conflicting files. Non-empty → `needs_update`; a submission that no longer conflicts gets its
 * status back from the review math. Call under the project lock.
 */
export async function recheckConflicts(
  tx: Tx,
  gitDir: string,
  projectId: string,
  main: string,
): Promise<void> {
  const subs = await tx.submission.findMany({
    where: { projectId, status: { in: ACTIVE } },
    select: {
      id: true,
      status: true,
      baseSha: true,
      headSha: true,
      version: true,
      conflictPaths: true,
      reviews: { select: reviewSelect },
    },
  });
  for (const sub of subs) {
    const { conflicts } = await mergeTree(gitDir, sub.baseSha, main, sub.headSha);
    const stored = [...sub.conflictPaths].sort();
    if (conflicts.length > 0) {
      if (sub.status !== 'needs_update' || !sameList(stored, conflicts)) {
        await tx.submission.updateMany({
          where: { id: sub.id, version: sub.version, status: { in: ACTIVE } },
          data: { status: 'needs_update', conflictPaths: conflicts },
        });
      }
    } else if (sub.status === 'needs_update') {
      await tx.submission.updateMany({
        where: { id: sub.id, version: sub.version, status: 'needs_update' },
        data: { status: statusFromReviews(sub.reviews, sub.version), conflictPaths: [] },
      });
    } else if (stored.length > 0) {
      await tx.submission.updateMany({ where: { id: sub.id }, data: { conflictPaths: [] } });
    }
  }
}

/** The re-check on its own (after a submit or an update), under the project lock. */
export async function recheckProject(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repoPath: true, repoStatus: true },
  });
  if (!project?.repoPath || project.repoStatus !== 'ready') return;
  const gitDir = project.repoPath;
  await withProjectLock(projectId, async (tx) => {
    const main = await resolveCommit(gitDir, MAIN_REF);
    if (main) await recheckConflicts(tx, gitDir, projectId, main);
  });
}

/** After main moved: queue the copy updates when the project updates copies automatically. */
async function afterMainMoved(projectId: string, settings: ProjectSettings): Promise<void> {
  // Read the settings again: they may have changed since the request started.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { settings: true },
  });
  const mode = project ? readSettings(project.settings).copyUpdateMode : settings.copyUpdateMode;
  if (mode === 'automatic') await queueCopyUpdates(projectId);
}

// ---------- Merge ----------

/** The merge commit's message: title, description (if any), then the submission id. */
export function mergeMessage(sub: { id: string; title: string; description: string }): string {
  const parts = [sub.title.trim()];
  if (sub.description.trim()) parts.push(sub.description.trim());
  parts.push(`Submission: ${sub.id}`);
  return `${parts.join('\n\n')}\n`;
}

type MergeOutcome =
  | { kind: 'merged' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'approval_required' }
  | { kind: 'already_in_main' };

/**
 * POST /submissions/:id/merge — `submission.merge`. One clean merge = exactly one new commit on
 * main: author = the submission's author, committer = the merging lead, parent = main.
 */
export async function mergeSubmission(
  access: ProjectAccess,
  leader: Leader,
  id: string,
): Promise<void> {
  const gitDir = gitDirOf(access);
  const found = await prisma.submission.findFirst({
    where: { id, projectId: access.project.id },
    select: { id: true },
  });
  if (!found) throw notFound();
  if (!can(access.role, access.permissions, 'submission.merge')) throw forbidden();
  const settings = access.project.settings;

  const outcome = await withProjectLock(access.project.id, async (tx): Promise<MergeOutcome> => {
    await tx.$queryRaw`SELECT 1 FROM submissions WHERE id = ${id} FOR UPDATE`;
    const sub = await tx.submission.findFirst({
      where: { id, projectId: access.project.id },
      include: {
        author: { select: { name: true, email: true } },
        reviews: { select: reviewSelect },
      },
    });
    if (!sub) throw notFound();
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    if (settings.requireApproval && sub.status !== 'approved' && sub.status !== 'needs_update') {
      return { kind: 'approval_required' };
    }

    const main = await currentMain(gitDir);
    const merged = await mergeTree(gitDir, sub.baseSha, main, sub.headSha);
    if (merged.conflicts.length > 0) {
      await tx.submission.update({
        where: { id: sub.id },
        data: { status: 'needs_update', conflictPaths: merged.conflicts },
      });
      return { kind: 'conflict', paths: merged.conflicts };
    }

    // It no longer conflicts (main changed back): its status comes from the reviews again.
    let status = sub.status;
    if (status === 'needs_update') {
      status = statusFromReviews(sub.reviews, sub.version);
      await tx.submission.update({
        where: { id: sub.id },
        data: { status, conflictPaths: [] },
      });
    }
    if (settings.requireApproval && status !== 'approved') return { kind: 'approval_required' };
    if (merged.tree === (await treeOf(gitDir, main))) return { kind: 'already_in_main' };

    const now = new Date();
    const commit = await writeCommit(
      gitDir,
      merged.tree,
      [main],
      mergeMessage(sub),
      { name: sub.author.name, email: sub.author.email },
      now,
      leader,
    );
    await tx.submission.update({
      where: { id: sub.id },
      data: {
        status: 'merged',
        mergedSha: commit,
        mergedById: leader.id,
        mergedAt: now,
        conflictPaths: [],
      },
    });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: leader.id,
      action: 'submission.merged',
      target: sub.id,
      data: { title: sub.title, sha: commit },
    });
    // Phase 8: the linked task waits for a lead's "Mark this task done?".
    if (sub.taskId) await onSubmissionMerged(tx, sub.taskId);
    // Last: main moves only if nothing above failed, and only from the main we merged into.
    await moveMain(gitDir, commit, main);
    await recheckConflicts(tx, gitDir, sub.projectId, commit);
    return { kind: 'merged' };
  });

  switch (outcome.kind) {
    case 'conflict':
      throw new HttpError(
        409,
        'merge_conflict',
        'This submission conflicts with main; the author must update their copy first',
        undefined,
        { paths: outcome.paths },
      );
    case 'approval_required':
      throw new HttpError(
        409,
        'approval_required',
        'This project needs an approval before merging',
      );
    case 'already_in_main':
      throw new HttpError(409, 'already_in_main', 'Main already has these changes');
    case 'merged':
      await afterMainMoved(access.project.id, settings);
  }
}

// ---------- Revert ----------

/** The revert commit's message. */
export function revertMessage(sub: { id: string; title: string; mergedSha: string }): string {
  return `Revert "${sub.title.trim()}"\n\nThis reverts submission ${sub.id} (commit ${sub.mergedSha}).\n`;
}

/**
 * POST /submissions/:id/revert — `submission.revert`, status `merged`. Adds one commit on main
 * that undoes the merge (author and committer = the lead). If later merges changed the same
 * lines it is refused (409 `revert_conflict`) and main is left untouched.
 */
export async function revertSubmission(
  access: ProjectAccess,
  leader: Leader,
  id: string,
): Promise<void> {
  const gitDir = gitDirOf(access);
  const found = await prisma.submission.findFirst({
    where: { id, projectId: access.project.id },
    select: { id: true },
  });
  if (!found) throw notFound();
  if (!can(access.role, access.permissions, 'submission.revert')) throw forbidden();

  const conflict = await withProjectLock(access.project.id, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM submissions WHERE id = ${id} FOR UPDATE`;
    const sub = await tx.submission.findFirst({ where: { id, projectId: access.project.id } });
    if (!sub) throw notFound();
    if (sub.status !== 'merged' || !sub.mergedSha) throw notActive();
    const parent = await parentOf(gitDir, sub.mergedSha);
    if (!parent) throw notActive();

    const main = await currentMain(gitDir);
    const result = await mergeTree(gitDir, sub.mergedSha, main, parent);
    if (result.conflicts.length > 0) return result.conflicts;

    const now = new Date();
    const commit = await writeCommit(
      gitDir,
      result.tree,
      [main],
      revertMessage({ id: sub.id, title: sub.title, mergedSha: sub.mergedSha }),
      leader,
      now,
    );
    await tx.submission.update({
      where: { id: sub.id },
      data: { status: 'reverted', revertedSha: commit, revertedById: leader.id, revertedAt: now },
    });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: leader.id,
      action: 'submission.reverted',
      target: sub.id,
      data: { title: sub.title, sha: commit },
    });
    // Phase 8: a done (or waiting) linked task goes back to In progress with a note.
    if (sub.taskId) await onSubmissionReverted(tx, sub.taskId, sub.title);
    await moveMain(gitDir, commit, main);
    await recheckConflicts(tx, gitDir, sub.projectId, commit);
    return null;
  });

  if (conflict) {
    throw new HttpError(
      409,
      'revert_conflict',
      'Later changes to main touch the same lines, so this merge can’t be undone automatically',
      undefined,
      { paths: conflict },
    );
  }
  await afterMainMoved(access.project.id, access.project.settings);
}
