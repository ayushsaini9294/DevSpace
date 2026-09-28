import { ACTIVE_SUBMISSION_STATUSES, type TaskStatus } from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { HttpError } from '../lib/http-error.ts';
import type { Tx } from '../merge/lock.ts';
import { notify, projectLeads } from '../notifications/service.ts';
import { invalidateAfterCommit } from '../realtime/emitter.ts';

/**
 * The automatic task rules (Phase 8). Each runs inside the same transaction as the submission
 * change that triggers it, after that change is written, and locks the task's row first so a
 * manual move can't interleave. Automatic moves are logged as `task.moved` with no actor.
 */

const ACTIVE = [...ACTIVE_SUBMISSION_STATUSES];

const MAX_NOTE_TITLE = 150;

/** Locks a task's row for the rest of the transaction (a no-op for an unknown id). */
export async function lockTask(tx: Tx, taskId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM tasks WHERE id = ${taskId} FOR UPDATE`;
}

/** A position below every task now in that column. */
export async function bottomPosition(
  tx: Tx,
  projectId: string,
  status: TaskStatus,
): Promise<number> {
  const agg = await tx.task.aggregate({
    where: { projectId, status },
    _max: { position: true },
  });
  return (agg._max.position ?? 0) + 1;
}

/**
 * Checks that `taskId` may be linked to a submission of `projectId`: a task of that project
 * (else 400 `validation_error` on `taskId`) that isn't done (409 `task_done`). Locks the task.
 */
export async function assertTaskLinkable(tx: Tx, projectId: string, taskId: string) {
  await lockTask(tx, taskId);
  const task = await tx.task.findFirst({
    where: { id: taskId, projectId },
    select: { status: true },
  });
  if (!task) {
    throw new HttpError(400, 'validation_error', 'Some fields are invalid', {
      taskId: ['Pick a task of this project'],
    });
  }
  if (task.status === 'done') {
    throw new HttpError(409, 'task_done', 'That task is already done; pick another task');
  }
}

async function readLocked(tx: Tx, taskId: string) {
  await lockTask(tx, taskId);
  return tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, title: true, status: true, doneConfirmPending: true },
  });
}

type LockedTask = NonNullable<Awaited<ReturnType<typeof readLocked>>>;

/** Moves the task to `to` (bottom of the column) with `extra` changes, and logs a real move. */
async function autoSet(
  tx: Tx,
  task: LockedTask,
  to: TaskStatus,
  extra: Prisma.TaskUpdateInput = {},
): Promise<void> {
  const moved = to !== task.status;
  await tx.task.update({
    where: { id: task.id },
    data: {
      ...extra,
      ...(moved
        ? {
            status: to,
            position: await bottomPosition(tx, task.projectId, to),
            completedAt: to === 'done' ? new Date() : null,
          }
        : {}),
    },
  });
  // The board reloads even when only the prompt or note changed (no activity row then).
  await invalidateAfterCommit(tx, task.projectId, ['tasks']);
  if (moved) {
    await recordActivity(tx, {
      projectId: task.projectId,
      actorId: null,
      action: 'task.moved',
      target: task.id,
      data: { title: task.title, from: task.status, to, automatic: true },
    });
  }
}

/** Whether another active submission (not `exceptSubmissionId`) links the task. */
export async function hasActiveLinkedSubmission(
  db: Tx,
  taskId: string,
  exceptSubmissionId?: string,
): Promise<boolean> {
  const count = await db.submission.count({
    where: {
      taskId,
      status: { in: ACTIVE },
      ...(exceptSubmissionId ? { id: { not: exceptSubmissionId } } : {}),
    },
  });
  return count > 0;
}

/** Rule 1: a linked submission opens (submit, or an update that leaves it linked) → In review. */
export async function onSubmissionOpened(tx: Tx, taskId: string): Promise<void> {
  const task = await readLocked(tx, taskId);
  if (!task || task.status === 'done') return;
  await autoSet(tx, task, 'in_review');
}

/** Rule 2: a linked submission merged → In review, waiting for a lead's confirmation. */
export async function onSubmissionMerged(
  tx: Tx,
  taskId: string,
  submissionId: string,
  actorId: string | null,
): Promise<void> {
  const task = await readLocked(tx, taskId);
  if (!task || task.status === 'done') return;
  await autoSet(tx, task, 'in_review', { doneConfirmPending: true });
  // Phase 9: leads are asked "Mark this task done?" (not the lead who just merged).
  await notify(tx, {
    type: 'task.confirm_done',
    projectId: task.projectId,
    userIds: await projectLeads(tx, task.projectId),
    actorId,
    data: { taskId: task.id, title: task.title, submissionId },
  });
}

/**
 * Rule 3: a linked submission was rejected or closed (or unlinked by an update) and no other
 * linked submission is active → In progress, unless a merge is waiting for confirmation.
 */
export async function onSubmissionEnded(
  tx: Tx,
  taskId: string,
  submissionId: string,
): Promise<void> {
  const task = await readLocked(tx, taskId);
  if (!task || task.status !== 'in_review' || task.doneConfirmPending) return;
  if (await hasActiveLinkedSubmission(tx, taskId, submissionId)) return;
  await autoSet(tx, task, 'in_progress');
}

/**
 * Rule 4: a linked merged submission was undone → if the task is done or waiting for
 * confirmation, back to In progress with a note saying why.
 */
export async function onSubmissionReverted(
  tx: Tx,
  taskId: string,
  submissionTitle: string,
  submissionId: string,
  actorId: string | null,
): Promise<void> {
  const task = await readLocked(tx, taskId);
  if (!task || (task.status !== 'done' && !task.doneConfirmPending)) return;
  const title =
    submissionTitle.length > MAX_NOTE_TITLE
      ? `${submissionTitle.slice(0, MAX_NOTE_TITLE - 1)}…`
      : submissionTitle;
  const note = `Merge of '${title}' was undone`;
  await autoSet(tx, task, 'in_progress', { doneConfirmPending: false, reopenNote: note });
  // Phase 9: its assignees are told.
  const assignees = await tx.taskAssignee.findMany({ where: { taskId }, select: { userId: true } });
  await notify(tx, {
    type: 'task.reopened',
    projectId: task.projectId,
    userIds: assignees.map((a) => a.userId),
    actorId,
    data: { taskId: task.id, title: task.title, submissionId, note },
  });
}
