import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitIdentity } from '../github/identity.ts';
import {
  ACTIVE_SUBMISSION_STATUSES,
  can,
  CommentSchema,
  CopyChangesResponseSchema,
  isActiveSubmissionStatus,
  MAX_FILE_VIEW_BYTES,
  MAX_SUBMISSION_FILE_BYTES,
  SubmissionDetailSchema,
  SubmissionFileResponseSchema,
  SubmissionSummarySchema,
  type Comment as CommentView,
  type CreateCommentRequest,
  type CreateReviewRequest,
  type CreateSubmissionRequest,
  type FileSide,
  type SubmissionStatus,
  type SubmissionViewerAction,
  type UpdateSubmissionRequest,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import { copyBaseSha, copyDir } from '../copies/service.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import {
  readBlob,
  resolveObject,
  treeWithChanges,
  updateRef,
  writeBlob,
  writeCommit,
  type Identity,
  type IndexChange,
} from '../git/repo.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { forbidden, type ProjectAccess } from '../projects/access.ts';
import { decodeText } from '../repository/service.ts';
import { removeDir } from '../repository/storage.ts';
import { withCopySubmissionLock } from '../merge/lock.ts';
import { recheckProject } from '../merge/service.ts';
import {
  assertTaskLinkable,
  lockTask,
  onSubmissionEnded,
  onSubmissionOpened,
} from '../tasks/automatic.ts';
import { diffCopy, openCopyFileForWrite, readChosen, type CopyChange } from './scan.ts';
import { approvalCount, mergeBlocker, reviewSelect, statusFromReviews } from './status.ts';
import { transaction } from '../lib/transaction.ts';
import { nameOf, notify, projectApprovers } from '../notifications/service.ts';

export { statusFromReviews };

type Tx = Prisma.TransactionClient;

/** Author identity for snapshot commits. */
export type Author = Identity & { id: string };

const ACTIVE = [...ACTIVE_SUBMISSION_STATUSES];

const notFound = () => new HttpError(404, 'not_found', 'Submission not found');
const notActive = () =>
  new HttpError(409, 'submission_not_active', 'This submission is no longer open');
const noCopy = () =>
  new HttpError(409, 'no_copy', "You don't have a copy of this project yet; open the IDE first");
const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");
const suggestionStale = (message = 'Those lines changed in your copy; update them by hand') =>
  new HttpError(409, 'suggestion_stale', message);

/** Where each version's snapshot commit is kept in the bare repository. */
export function snapshotRef(submissionId: string, version: number): string {
  return `refs/submissions/${submissionId}/v${version}`;
}

function gitDirOf(access: ProjectAccess): string {
  if (!access.project.repoPath) throw notReady();
  return access.project.repoPath;
}

function isLead(access: ProjectAccess): boolean {
  return access.role === 'leader' || access.role === 'co_leader';
}

/**
 * Submit, update and suggestion accept run under the copy's submission lock (merge/lock.ts),
 * so the file-lock rule and version numbers can't race; copy updates take it too.
 */

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(fn, { maxWait: 30_000, timeout: 180_000 });
}

/** Locks the submission's row for this transaction and reads it (404 if not in the project). */
async function lockSubmission(tx: Tx, projectId: string, id: string) {
  await tx.$queryRaw`SELECT 1 FROM submissions WHERE id = ${id} FOR UPDATE`;
  const row = await tx.submission.findFirst({
    where: { id, projectId },
    include: { files: { orderBy: { path: 'asc' } } },
  });
  if (!row) throw notFound();
  return row;
}

type LockedSubmission = Awaited<ReturnType<typeof lockSubmission>>;

async function myCopy(access: ProjectAccess) {
  const copy = await prisma.copy.findUnique({
    where: { projectId_userId: { projectId: access.project.id, userId: access.userId } },
    select: { id: true, baseSha: true },
  });
  if (!copy) throw noCopy();
  return copy;
}

// ---------- Changes and snapshots ----------

/** GET /copy/changes */
export async function copyChanges(access: ProjectAccess) {
  const gitDir = gitDirOf(access);
  const copy = await myCopy(access);
  const baseSha = await copyBaseSha(copy, gitDir);
  const changes = await diffCopy(gitDir, baseSha, copyDir(access.project.id, copy.id));
  const locked = await prisma.submissionFile.findMany({
    where: { submission: { copyId: copy.id, status: { in: ACTIVE } } },
    select: { path: true, submissionId: true },
  });
  const lockedBy = new Map(locked.map((f) => [f.path, f.submissionId]));
  return CopyChangesResponseSchema.parse({
    baseSha,
    files: [...changes.values()].map((c) => ({
      path: c.path,
      change: c.change,
      openSubmissionId: lockedBy.get(c.path) ?? null,
    })),
  });
}

function pickChanges(changes: Map<string, CopyChange>, paths: readonly string[]): CopyChange[] {
  const missing = paths.filter((p) => !changes.has(p));
  if (missing.length > 0) {
    throw new HttpError(
      409,
      'no_changes',
      missing.length === 1
        ? `${missing[0]} has no changes in your copy`
        : `${missing.length} of the files have no changes in your copy`,
      undefined,
      { paths: missing },
    );
  }
  return paths.map((p) => changes.get(p)!);
}

/** A path may be in only one of the author's active submissions. */
async function assertFilesFree(
  tx: Tx,
  copyId: string,
  paths: readonly string[],
  exceptSubmissionId?: string,
) {
  const clashes = await tx.submissionFile.findMany({
    where: {
      path: { in: [...paths] },
      submission: {
        copyId,
        status: { in: ACTIVE },
        ...(exceptSubmissionId ? { id: { not: exceptSubmissionId } } : {}),
      },
    },
    select: { path: true, submissionId: true },
    orderBy: { path: 'asc' },
  });
  if (clashes.length > 0) {
    throw new HttpError(
      409,
      'file_in_open_submission',
      'Some files are already in another open submission of yours',
      undefined,
      { paths: clashes.map((c) => c.path), submissionId: clashes[0]!.submissionId },
    );
  }
}

/**
 * Builds the snapshot commit in the bare repository: `baseSha`'s tree with only the chosen
 * paths replaced, added or removed; parent `baseSha`; author the member; message the title.
 */
async function buildSnapshot(
  gitDir: string,
  baseSha: string,
  root: string,
  chosen: readonly CopyChange[],
  title: string,
  author: Author,
): Promise<string> {
  const contents = await readChosen(root, chosen);
  const changes: IndexChange[] = [];
  for (const change of chosen) {
    const bytes = contents.get(change.path);
    changes.push({
      path: change.path,
      entry:
        change.disk && bytes
          ? { mode: change.disk.mode, sha: await writeBlob(gitDir, bytes) }
          : null,
    });
  }
  const temp = await mkdtemp(join(tmpdir(), 'devspace-index-'));
  try {
    const tree = await treeWithChanges(gitDir, baseSha, changes, join(temp, 'index'));
    return await writeCommit(gitDir, tree, [baseSha], `${title}\n`, await commitIdentity(author));
  } finally {
    await removeDir(temp).catch(() => undefined);
  }
}

// ---------- Submit and update ----------

/** POST /submissions. Returns the new submission's id. */
export async function createSubmission(
  access: ProjectAccess,
  author: Author,
  input: CreateSubmissionRequest,
): Promise<string> {
  const gitDir = gitDirOf(access);
  const copy = await myCopy(access);
  const baseSha = await copyBaseSha(copy, gitDir);
  const root = copyDir(access.project.id, copy.id);
  const id = randomUUID();
  const taskId = input.taskId ?? null;
  await withCopySubmissionLock(copy.id, async (tx) => {
    if (taskId) await assertTaskLinkable(tx, access.project.id, taskId);
    const chosen = pickChanges(await diffCopy(gitDir, baseSha, root), input.paths);
    await assertFilesFree(tx, copy.id, input.paths);
    const head = await buildSnapshot(gitDir, baseSha, root, chosen, input.title, author);
    await tx.submission.create({
      data: {
        id,
        projectId: access.project.id,
        copyId: copy.id,
        authorId: author.id,
        taskId,
        title: input.title,
        description: input.description,
        baseSha,
        headSha: head,
        files: { create: chosen.map((c) => ({ path: c.path, change: c.change })) },
      },
    });
    await recordActivity(tx, {
      projectId: access.project.id,
      actorId: author.id,
      action: 'submission.created',
      target: id,
      data: { title: input.title, version: 1, files: chosen.length, taskId },
    });
    await notify(tx, {
      type: 'submission.opened',
      projectId: access.project.id,
      userIds: await projectApprovers(tx, access.project.id),
      actorId: author.id,
      data: { submissionId: id, title: input.title, actorName: author.name },
    });
    if (taskId) await onSubmissionOpened(tx, taskId);
    await updateRef(gitDir, snapshotRef(id, 1), head);
  });
  await recheckAfter(access.project.id);
  return id;
}

/** After a submit or update: re-check every active submission against main (Phase 7). */
async function recheckAfter(projectId: string): Promise<void> {
  try {
    await recheckProject(projectId);
  } catch (err) {
    console.error(
      `Could not re-check the submissions of project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The shared core of an update (also run after a suggestion is accepted): re-reads the files
 * from the author's copy, builds version n+1, marks earlier reviews stale (by version) and sets
 * the status back to `open`. Runs inside the copy's submission lock.
 */
async function applyUpdate(
  tx: Tx,
  gitDir: string,
  sub: LockedSubmission,
  input: UpdateSubmissionRequest,
  author: Author,
): Promise<void> {
  if (!isActiveSubmissionStatus(sub.status)) throw notActive();
  // Phase 8: a task id links it (checked), null unlinks, missing keeps the link.
  const taskId = input.taskId === undefined ? sub.taskId : input.taskId;
  // Lock the old and new task in a fixed order, so two updates swapping tasks can't deadlock.
  for (const t of [...new Set([sub.taskId, taskId])].filter((v) => v !== null).sort()) {
    await lockTask(tx, t);
  }
  if (input.taskId && input.taskId !== sub.taskId) {
    await assertTaskLinkable(tx, sub.projectId, input.taskId);
  }
  const copy = await tx.copy.findUniqueOrThrow({
    where: { id: sub.copyId },
    select: { id: true, baseSha: true },
  });
  const baseSha = await copyBaseSha(copy, gitDir);
  const root = copyDir(sub.projectId, sub.copyId);
  const paths = input.paths ?? sub.files.map((f) => f.path);
  const chosen = pickChanges(await diffCopy(gitDir, baseSha, root), paths);
  await assertFilesFree(tx, sub.copyId, paths, sub.id);
  const title = input.title ?? sub.title;
  const head = await buildSnapshot(gitDir, baseSha, root, chosen, title, author);
  const version = sub.version + 1;
  const { count } = await tx.submission.updateMany({
    where: { id: sub.id, version: sub.version, status: { in: ACTIVE } },
    data: {
      title,
      description: input.description ?? sub.description,
      baseSha,
      headSha: head,
      version,
      status: 'open',
      conflictPaths: [],
      taskId,
    },
  });
  if (count !== 1) throw notActive();
  await tx.submissionFile.deleteMany({ where: { submissionId: sub.id } });
  await tx.submissionFile.createMany({
    data: chosen.map((c) => ({ submissionId: sub.id, path: c.path, change: c.change })),
  });
  await recordActivity(tx, {
    projectId: sub.projectId,
    actorId: author.id,
    action: 'submission.updated',
    target: sub.id,
    data: { title, version, files: chosen.length, taskId },
  });
  // The task it no longer links is treated as if this submission had closed.
  if (sub.taskId && sub.taskId !== taskId) await onSubmissionEnded(tx, sub.taskId, sub.id);
  if (taskId) await onSubmissionOpened(tx, taskId);
  await updateRef(gitDir, snapshotRef(sub.id, version), head);
}

async function findSubmission(projectId: string, id: string) {
  const row = await prisma.submission.findFirst({
    where: { id, projectId },
    select: { id: true, copyId: true, authorId: true, status: true },
  });
  if (!row) throw notFound();
  return row;
}

/** POST /submissions/:id/update — the author only, while active. */
export async function updateSubmission(
  access: ProjectAccess,
  author: Author,
  id: string,
  input: UpdateSubmissionRequest,
): Promise<void> {
  const gitDir = gitDirOf(access);
  const found = await findSubmission(access.project.id, id);
  if (found.authorId !== access.userId) throw forbidden('Only the author can update a submission');
  if (!isActiveSubmissionStatus(found.status)) throw notActive();
  await withCopySubmissionLock(found.copyId, async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    await applyUpdate(tx, gitDir, sub, input, author);
  });
  await recheckAfter(access.project.id);
}

// ---------- Reading ----------

/** One side of a file: text, binary, too large, or missing (`none`). */
async function readSide(gitDir: string, commit: string, path: string): Promise<FileSide> {
  const object = await resolveObject(gitDir, `${commit}:${path}`);
  if (!object || object.type !== 'blob') return { kind: 'none' };
  if (object.size > MAX_FILE_VIEW_BYTES) return { kind: 'too_large' };
  const text = decodeText(await readBlob(gitDir, object.sha, MAX_FILE_VIEW_BYTES));
  return text === null ? { kind: 'binary' } : { kind: 'text', content: text };
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

function viewerActions(
  access: ProjectAccess,
  sub: {
    authorId: string;
    status: SubmissionStatus;
    task: { doneConfirmPending: boolean } | null;
  },
): SubmissionViewerAction[] {
  const blocker = mergeBlocker(sub.status, access.project.settings);
  const active = isActiveSubmissionStatus(sub.status);
  const isAuthor = sub.authorId === access.userId;
  const may = (action: Parameters<typeof can>[2]) => can(access.role, access.permissions, action);
  const actions: SubmissionViewerAction[] = [];
  if (isAuthor && active) actions.push('update');
  if (isAuthor || may('submission.comment')) actions.push('comment');
  if (active && may('submission.comment')) actions.push('suggest');
  if (isAuthor && active) actions.push('respondSuggestion');
  if (active && !isAuthor && may('submission.approve')) actions.push('approve', 'requestChanges');
  if (active && may('submission.reject')) actions.push('reject');
  if (active && (isAuthor || isLead(access))) actions.push('close');
  if (blocker === null && may('submission.merge')) actions.push('merge');
  if (sub.status === 'merged' && may('submission.revert')) actions.push('revert');
  if (isLead(access) && sub.task?.doneConfirmPending) actions.push('confirmTaskDone');
  return actions;
}

const linkedTaskSelect = {
  select: { id: true, title: true, status: true, doneConfirmPending: true },
} as const;

function linkedTask(task: { id: string; title: string; status: string } | null) {
  return task ? { id: task.id, title: task.title, status: task.status } : null;
}

/** GET /submissions?status= — newest first. */
export async function listSubmissions(access: ProjectAccess, status: 'active' | 'all') {
  const rows = await prisma.submission.findMany({
    where: {
      projectId: access.project.id,
      ...(status === 'active' ? { status: { in: ACTIVE } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      author: { select: { id: true, name: true } },
      reviews: { select: reviewSelect },
      _count: { select: { files: true, comments: true } },
      task: linkedTaskSelect,
    },
  });
  return {
    submissions: rows.map((row) =>
      SubmissionSummarySchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        author: row.author,
        version: row.version,
        fileCount: row._count.files,
        commentCount: row._count.comments,
        approvals: approvalCount(row.reviews, row.version),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        task: linkedTask(row.task),
      }),
    ),
  };
}

interface CommentRow {
  id: string;
  parentId: string | null;
  path: string | null;
  side: 'base' | 'head' | null;
  line: number | null;
  startLine: number | null;
  lineText: string | null;
  version: number;
  body: string;
  suggestion: string | null;
  suggestionStatus: 'pending' | 'accepted' | 'rejected' | null;
  createdAt: Date;
  author: { id: string; name: string };
}

function toCommentView(row: CommentRow, outdated: boolean): CommentView {
  return CommentSchema.parse({
    id: row.id,
    author: row.author,
    parentId: row.parentId,
    path: row.path,
    side: row.side,
    line: row.line,
    startLine: row.startLine,
    version: row.version,
    body: row.body,
    suggestion: row.suggestion,
    suggestionStatus: row.suggestionStatus,
    outdated,
    createdAt: row.createdAt.toISOString(),
  });
}

/** GET /submissions/:id, and the answer of every action. */
export async function submissionDetail(access: ProjectAccess, id: string) {
  const gitDir = gitDirOf(access);
  const row = await prisma.submission.findFirst({
    where: { id, projectId: access.project.id },
    include: {
      author: { select: { id: true, name: true } },
      mergedBy: { select: { id: true, name: true } },
      revertedBy: { select: { id: true, name: true } },
      task: linkedTaskSelect,
      files: { orderBy: { path: 'asc' } },
      reviews: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { reviewer: { select: { id: true, name: true } } },
      },
      comments: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { author: { select: { id: true, name: true } } },
      },
    },
  });
  if (!row) throw notFound();

  // Outdated: the file left the submission, or the commented line's text changed.
  const inSubmission = new Set(row.files.map((f) => f.path));
  const sides = new Map<string, Promise<string[] | null>>();
  const linesOf = (side: 'base' | 'head', path: string) => {
    const key = `${side}\0${path}`;
    let lines = sides.get(key);
    if (!lines) {
      lines = readSide(gitDir, side === 'base' ? row.baseSha : row.headSha, path).then((s) =>
        s.kind === 'text' ? splitLines(s.content) : null,
      );
      sides.set(key, lines);
    }
    return lines;
  };
  const comments: CommentView[] = [];
  for (const comment of row.comments) {
    let outdated = false;
    if (comment.path !== null && comment.side !== null && comment.line !== null) {
      if (!inSubmission.has(comment.path)) {
        outdated = true;
      } else {
        const lines = await linesOf(comment.side, comment.path);
        outdated = !lines || lines[comment.line - 1] !== comment.lineText;
      }
    }
    comments.push(toCommentView(comment, outdated));
  }

  return SubmissionDetailSchema.parse({
    id: row.id,
    title: row.title,
    status: row.status,
    author: row.author,
    version: row.version,
    fileCount: row.files.length,
    commentCount: row.comments.length,
    approvals: approvalCount(row.reviews, row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    task: linkedTask(row.task),
    description: row.description,
    baseSha: row.baseSha,
    headSha: row.headSha,
    rejectReason: row.rejectReason,
    closedAt: row.closedAt?.toISOString() ?? null,
    files: row.files.map((f) => ({ path: f.path, change: f.change })),
    reviews: row.reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      decision: r.decision,
      body: r.body,
      version: r.version,
      stale: r.version < row.version,
      createdAt: r.createdAt.toISOString(),
    })),
    comments,
    viewerActions: viewerActions(access, row),
    conflictPaths: [...row.conflictPaths].sort(),
    mergedSha: row.mergedSha,
    mergedBy: row.mergedBy,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    revertedSha: row.revertedSha,
    revertedBy: row.revertedBy,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    mergeBlocker: mergeBlocker(row.status, access.project.settings),
  });
}

/** GET /submissions/:id/file?path= — a file of the current version, both sides. */
export async function submissionFile(access: ProjectAccess, id: string, path: string) {
  const gitDir = gitDirOf(access);
  const row = await prisma.submission.findFirst({
    where: { id, projectId: access.project.id },
    select: { baseSha: true, headSha: true, files: { where: { path } } },
  });
  if (!row) throw notFound();
  const file = row.files[0];
  if (!file) throw new HttpError(404, 'not_found', 'That file is not in this submission');
  const [base, head] = await Promise.all([
    readSide(gitDir, row.baseSha, path),
    readSide(gitDir, row.headSha, path),
  ]);
  return SubmissionFileResponseSchema.parse({ path, change: file.change, base, head });
}

// ---------- Comments and suggestions ----------

const lineProblem = (field: string, message: string) =>
  new HttpError(400, 'validation_error', 'Some fields are invalid', { [field]: [message] });

/** POST /submissions/:id/comments. Returns the new comment. */
export async function addComment(
  access: ProjectAccess,
  id: string,
  input: CreateCommentRequest,
): Promise<CommentView> {
  const gitDir = gitDirOf(access);
  const sub = await prisma.submission.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      id: true,
      authorId: true,
      title: true,
      status: true,
      version: true,
      baseSha: true,
      headSha: true,
      files: { select: { path: true } },
    },
  });
  if (!sub) throw notFound();
  const canComment = can(access.role, access.permissions, 'submission.comment');
  if (!canComment && sub.authorId !== access.userId) throw forbidden();
  if (input.suggestion !== undefined) {
    if (!canComment) throw forbidden('You need the Comment permission to suggest changes');
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
  }

  let parentId: string | null = null;
  let parentAuthorId: string | null = null;
  if (input.parentId !== undefined) {
    const parent = await prisma.comment.findFirst({
      where: { id: input.parentId, submissionId: sub.id },
      select: { id: true, parentId: true, authorId: true },
    });
    if (!parent) throw new HttpError(404, 'not_found', 'Comment not found');
    parentAuthorId = parent.authorId;
    // Replies are one level deep: a reply to a reply joins the same thread.
    parentId = parent.parentId ?? parent.id;
  }

  let location: {
    path: string;
    side: 'base' | 'head';
    line: number;
    startLine: number;
    lineText: string;
  } | null = null;
  if (input.path !== undefined && input.side !== undefined && input.line !== undefined) {
    if (!sub.files.some((f) => f.path === input.path)) {
      throw lineProblem('path', 'That file is not in this submission');
    }
    const side = await readSide(
      gitDir,
      input.side === 'base' ? sub.baseSha : sub.headSha,
      input.path,
    );
    if (side.kind !== 'text') {
      throw lineProblem('line', 'Line comments need a text file on that side');
    }
    const lines = splitLines(side.content);
    if (input.line > lines.length) throw lineProblem('line', 'That line is not in the file');
    location = {
      path: input.path,
      side: input.side,
      line: input.line,
      startLine: input.startLine ?? input.line,
      lineText: lines[input.line - 1]!,
    };
  }

  const created = await inTx(async (tx) => {
    const row = await tx.comment.create({
      data: {
        submissionId: sub.id,
        authorId: access.userId,
        parentId,
        path: location?.path ?? null,
        side: location?.side ?? null,
        line: location?.line ?? null,
        startLine: location?.startLine ?? null,
        lineText: location?.lineText ?? null,
        version: sub.version,
        body: input.body,
        suggestion: input.suggestion ?? null,
        suggestionStatus: input.suggestion !== undefined ? 'pending' : null,
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await recordActivity(tx, {
      projectId: access.project.id,
      actorId: access.userId,
      action: 'submission.commented',
      target: sub.id,
      data: {
        commentId: row.id,
        ...(location ? { path: location.path, line: location.line } : {}),
        ...(parentId ? { replyTo: parentId } : {}),
        suggestion: input.suggestion !== undefined,
      },
    });
    const commented = {
      submissionId: sub.id,
      title: sub.title,
      actorName: row.author.name,
      commentId: row.id,
      suggestion: input.suggestion !== undefined,
    };
    await notify(tx, {
      type: 'submission.commented',
      projectId: access.project.id,
      userIds: [sub.authorId],
      actorId: access.userId,
      data: { ...commented, reply: false },
    });
    // A reply also tells the author of the comment it answers (once, if that's the author too).
    if (parentAuthorId && parentAuthorId !== sub.authorId) {
      await notify(tx, {
        type: 'submission.commented',
        projectId: access.project.id,
        userIds: [parentAuthorId],
        actorId: access.userId,
        data: { ...commented, reply: true },
      });
    }
    return row;
  });
  return toCommentView(created, false);
}

const notPending = () =>
  new HttpError(409, 'suggestion_not_pending', 'This suggestion was already answered');

/**
 * Accepts a suggestion: writes the replacement into the author's copy (only if those lines
 * there still equal the submission's current head), then updates the submission with the
 * same files. If anything after the write fails, the file's old bytes are put back.
 */
async function acceptSuggestion(
  access: ProjectAccess,
  author: Author,
  gitDir: string,
  copyId: string,
  id: string,
  commentId: string,
): Promise<void> {
  await withCopySubmissionLock(copyId, async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    const comment = await tx.comment.findFirst({ where: { id: commentId, submissionId: sub.id } });
    if (!comment) throw new HttpError(404, 'not_found', 'Comment not found');
    if (comment.suggestion === null || comment.suggestionStatus !== 'pending') throw notPending();
    const { path, line } = comment;
    if (path === null || line === null || !sub.files.some((f) => f.path === path)) {
      throw suggestionStale('That file is no longer in this submission');
    }
    const head = await readSide(gitDir, sub.headSha, path);
    if (head.kind !== 'text') throw suggestionStale();
    const first = comment.startLine ?? line;
    const headLines = splitLines(head.content);

    const root = copyDir(sub.projectId, sub.copyId);
    const handle = await openCopyFileForWrite(root, path);
    if (!handle) throw suggestionStale('That file is missing or not a regular file in your copy');
    let original: Buffer;
    try {
      const size = (await handle.stat()).size;
      if (size > MAX_SUBMISSION_FILE_BYTES) throw suggestionStale();
      original = await handle.readFile();
      const text = decodeText(original);
      if (text === null) throw suggestionStale();
      const diskLines = splitLines(text);
      if (line > headLines.length || line > diskLines.length) throw suggestionStale();
      for (let i = first - 1; i < line; i++) {
        if (headLines[i] !== diskLines[i]) throw suggestionStale();
      }
      const crlf = diskLines.slice(first - 1, line).every((l) => l.endsWith('\r'));
      const replacement =
        comment.suggestion === ''
          ? []
          : splitLines(comment.suggestion).map((l) => (crlf && !l.endsWith('\r') ? `${l}\r` : l));
      const next = Buffer.from(
        [...diskLines.slice(0, first - 1), ...replacement, ...diskLines.slice(line)].join('\n'),
        'utf8',
      );
      await handle.truncate(0);
      await handle.write(next, 0, next.length, 0);
    } finally {
      await handle.close();
    }

    try {
      await tx.comment.update({
        where: { id: comment.id },
        data: { suggestionStatus: 'accepted' },
      });
      await recordActivity(tx, {
        projectId: sub.projectId,
        actorId: author.id,
        action: 'submission.suggestion_accepted',
        target: sub.id,
        data: { commentId: comment.id, path },
      });
      await applyUpdate(tx, gitDir, sub, {}, author);
    } catch (err) {
      const restore = await openCopyFileForWrite(root, path);
      if (restore) {
        try {
          await restore.truncate(0);
          await restore.write(original, 0, original.length, 0);
        } finally {
          await restore.close();
        }
      }
      throw err;
    }
  });
}

/** POST /submissions/:id/comments/:commentId/suggestion — the author only, while active. */
export async function respondToSuggestion(
  access: ProjectAccess,
  author: Author,
  id: string,
  commentId: string,
  decision: 'accept' | 'reject',
): Promise<void> {
  const gitDir = gitDirOf(access);
  const found = await findSubmission(access.project.id, id);
  if (found.authorId !== access.userId) {
    throw forbidden('Only the author can accept or reject suggestions');
  }
  if (!isActiveSubmissionStatus(found.status)) throw notActive();
  if (decision === 'accept') {
    await acceptSuggestion(access, author, gitDir, found.copyId, id, commentId);
    await recheckAfter(access.project.id);
    return;
  }
  await inTx(async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    const comment = await tx.comment.findFirst({
      where: { id: commentId, submissionId: sub.id },
      select: { id: true, suggestion: true, suggestionStatus: true, path: true },
    });
    if (!comment) throw new HttpError(404, 'not_found', 'Comment not found');
    if (comment.suggestion === null || comment.suggestionStatus !== 'pending') throw notPending();
    await tx.comment.update({ where: { id: comment.id }, data: { suggestionStatus: 'rejected' } });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: access.userId,
      action: 'submission.suggestion_rejected',
      target: sub.id,
      data: { commentId: comment.id, path: comment.path },
    });
  });
}

// ---------- Reviews, reject, close ----------

/** POST /submissions/:id/reviews — `submission.approve`, never the author, while active. */
export async function addReview(
  access: ProjectAccess,
  id: string,
  input: CreateReviewRequest,
): Promise<void> {
  const found = await findSubmission(access.project.id, id);
  if (found.authorId === access.userId) {
    throw new HttpError(403, 'own_submission', "You can't review your own submission");
  }
  if (!can(access.role, access.permissions, 'submission.approve')) throw forbidden();
  await inTx(async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    await tx.review.create({
      data: {
        submissionId: sub.id,
        reviewerId: access.userId,
        decision: input.decision,
        body: input.body?.trim() ? input.body : null,
        version: sub.version,
      },
    });
    const reviews = await tx.review.findMany({
      where: { submissionId: sub.id },
      select: reviewSelect,
    });
    await tx.submission.update({
      where: { id: sub.id },
      data: { status: statusFromReviews(reviews, sub.version) },
    });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: access.userId,
      action: 'submission.reviewed',
      target: sub.id,
      data: { decision: input.decision, version: sub.version },
    });
    await notify(tx, {
      type: 'submission.reviewed',
      projectId: sub.projectId,
      userIds: [sub.authorId],
      actorId: access.userId,
      data: {
        submissionId: sub.id,
        title: sub.title,
        actorName: await nameOf(tx, access.userId),
        decision: input.decision,
      },
    });
  });
}

/** POST /submissions/:id/reject — `submission.reject`, while active. */
export async function rejectSubmission(
  access: ProjectAccess,
  id: string,
  reason: string,
): Promise<void> {
  await findSubmission(access.project.id, id);
  if (!can(access.role, access.permissions, 'submission.reject')) throw forbidden();
  await inTx(async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    await tx.submission.update({
      where: { id: sub.id },
      data: { status: 'rejected', rejectReason: reason, closedAt: new Date() },
    });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: access.userId,
      action: 'submission.rejected',
      target: sub.id,
      data: { reason },
    });
    await notify(tx, {
      type: 'submission.rejected',
      projectId: sub.projectId,
      userIds: [sub.authorId],
      actorId: access.userId,
      data: {
        submissionId: sub.id,
        title: sub.title,
        actorName: await nameOf(tx, access.userId),
        reason,
      },
    });
    if (sub.taskId) await onSubmissionEnded(tx, sub.taskId, sub.id);
  });
}

/** POST /submissions/:id/close — the author or a leader or co-leader, while active. */
export async function closeSubmission(access: ProjectAccess, id: string): Promise<void> {
  const found = await findSubmission(access.project.id, id);
  if (found.authorId !== access.userId && !isLead(access)) throw forbidden();
  await inTx(async (tx) => {
    const sub = await lockSubmission(tx, access.project.id, id);
    if (!isActiveSubmissionStatus(sub.status)) throw notActive();
    await tx.submission.update({
      where: { id: sub.id },
      data: { status: 'closed', closedAt: new Date() },
    });
    await recordActivity(tx, {
      projectId: sub.projectId,
      actorId: access.userId,
      action: 'submission.closed',
      target: sub.id,
      data: {},
    });
    if (sub.taskId) await onSubmissionEnded(tx, sub.taskId, sub.id);
  });
}
