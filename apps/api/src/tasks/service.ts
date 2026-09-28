import {
  allowedTaskMoves,
  can,
  TaskViewSchema,
  type CreateTaskRequest,
  type MoveTaskRequest,
  type TaskStatus,
  type TaskView,
  type TaskViewerAction,
  type UpdateTaskRequest,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import type { Tx } from '../merge/lock.ts';
import { forbidden, type ProjectAccess } from '../projects/access.ts';
import { bottomPosition, hasActiveLinkedSubmission, lockTask } from './automatic.ts';
import { transaction } from '../lib/transaction.ts';
import { nameOf, notify } from '../notifications/service.ts';

/** Tasks (Phase 8): the board, and the manual actions on it. Automatic rules: automatic.ts. */

const notFound = () => new HttpError(404, 'not_found', 'Task not found');

function isLead(access: ProjectAccess): boolean {
  return access.role === 'leader' || access.role === 'co_leader';
}

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(fn, { maxWait: 30_000, timeout: 60_000 });
}

const taskInclude = {
  assignees: { select: { user: { select: { id: true, name: true } } } },
  createdBy: { select: { id: true, name: true } },
  submissions: {
    select: { id: true, title: true, status: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function dateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

interface TaskFacts {
  createdById: string;
  status: TaskStatus;
  doneConfirmPending: boolean;
  assigneeIds: readonly string[];
}

function mayEdit(access: ProjectAccess, task: TaskFacts): boolean {
  return (
    isLead(access) ||
    (task.createdById === access.userId && can(access.role, access.permissions, 'task.create'))
  );
}

function viewerActions(access: ProjectAccess, task: TaskFacts): TaskViewerAction[] {
  const actions: TaskViewerAction[] = [];
  const lead = isLead(access);
  if (mayEdit(access, task)) actions.push('edit');
  const moves = allowedTaskMoves(task.status, {
    isLead: lead,
    isAssignee: task.assigneeIds.includes(access.userId),
  });
  if (moves.length > 0) actions.push('move');
  if (lead) actions.push('delete');
  if (lead && task.doneConfirmPending) actions.push('confirmDone');
  return actions;
}

function toView(access: ProjectAccess, row: TaskRow): TaskView {
  const assignees = row.assignees
    .map((a) => a.user)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return TaskViewSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueDate: dateOnly(row.dueDate),
    position: row.position,
    assignees,
    createdBy: row.createdBy,
    doneConfirmPending: row.doneConfirmPending,
    reopenNote: row.reopenNote,
    linkedSubmissions: row.submissions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    viewerActions: viewerActions(access, {
      createdById: row.createdById,
      status: row.status,
      doneConfirmPending: row.doneConfirmPending,
      assigneeIds: assignees.map((a) => a.id),
    }),
  });
}

/** GET /tasks — every task of the project, by column, then position. */
export async function listTasks(access: ProjectAccess): Promise<TaskView[]> {
  const rows = await prisma.task.findMany({
    where: { projectId: access.project.id },
    // The task_status enum is declared in board order, so it sorts that way.
    orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: taskInclude,
  });
  return rows.map((row) => toView(access, row));
}

/** One task as this viewer sees it (404 if not in the project). */
export async function taskDetail(access: ProjectAccess, id: string): Promise<TaskView> {
  const row = await prisma.task.findFirst({
    where: { id, projectId: access.project.id },
    include: taskInclude,
  });
  if (!row) throw notFound();
  return toView(access, row);
}

/**
 * Every id must be a current member of the project (400 on `assigneeIds` otherwise). The member
 * rows are share-locked, so a concurrent removal waits until the assignment is written (and then
 * removes it).
 */
async function assertMembers(tx: Tx, projectId: string, ids: readonly string[]): Promise<void> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM project_members
    WHERE project_id = ${projectId} AND user_id = ANY(${[...ids]}::text[])
    FOR SHARE`;
  if (rows.length !== ids.length) {
    throw new HttpError(400, 'validation_error', 'Some fields are invalid', {
      assigneeIds: ['Pick people who are members of this project'],
    });
  }
}

/** Locks and reads a task of the project with what the rules need (404 otherwise). */
async function lockedTask(tx: Tx, projectId: string, id: string) {
  await lockTask(tx, id);
  const task = await tx.task.findFirst({
    where: { id, projectId },
    include: { assignees: { select: { userId: true } } },
  });
  if (!task) throw notFound();
  return { ...task, assigneeIds: task.assignees.map((a) => a.userId) };
}

/** POST /tasks — `task.create`. New tasks go to the bottom of To do. Returns the id. */
export async function createTask(access: ProjectAccess, input: CreateTaskRequest): Promise<string> {
  if (!can(access.role, access.permissions, 'task.create')) {
    throw forbidden('You need the Create tasks permission');
  }
  const projectId = access.project.id;
  return inTx(async (tx) => {
    await assertMembers(tx, projectId, input.assigneeIds);
    const task = await tx.task.create({
      data: {
        projectId,
        title: input.title,
        description: input.description,
        dueDate: toDate(input.dueDate ?? null),
        createdById: access.userId,
        position: await bottomPosition(tx, projectId, 'todo'),
        assignees: { create: input.assigneeIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'task.created',
      target: task.id,
      data: { title: input.title, assigneeIds: input.assigneeIds },
    });
    await notify(tx, {
      type: 'task.assigned',
      projectId,
      userIds: input.assigneeIds,
      actorId: access.userId,
      data: { taskId: task.id, title: input.title, actorName: await nameOf(tx, access.userId) },
    });
    return task.id;
  });
}

/** PATCH /tasks/:taskId — leads on any task; the creator on their own while they have `task.create`. */
export async function updateTask(
  access: ProjectAccess,
  id: string,
  input: UpdateTaskRequest,
): Promise<void> {
  const projectId = access.project.id;
  await inTx(async (tx) => {
    const task = await lockedTask(tx, projectId, id);
    if (!mayEdit(access, task)) throw forbidden('You can’t edit this task');
    const fields: string[] = [];
    const data: Prisma.TaskUpdateInput = {};
    if (input.title !== undefined && input.title !== task.title) {
      data.title = input.title;
      fields.push('title');
    }
    if (input.description !== undefined && input.description !== task.description) {
      data.description = input.description;
      fields.push('description');
    }
    if (input.dueDate !== undefined && input.dueDate !== dateOnly(task.dueDate)) {
      data.dueDate = toDate(input.dueDate);
      fields.push('dueDate');
    }
    if (input.assigneeIds !== undefined) {
      await assertMembers(tx, projectId, input.assigneeIds);
      const next = [...input.assigneeIds].sort();
      const current = [...task.assigneeIds].sort();
      if (next.length !== current.length || next.some((v, i) => v !== current[i])) {
        await tx.taskAssignee.deleteMany({ where: { taskId: id } });
        await tx.taskAssignee.createMany({
          data: input.assigneeIds.map((userId) => ({ taskId: id, userId })),
        });
        fields.push('assigneeIds');
      }
    }
    if (fields.length === 0) return;
    // Always touch the row, so updatedAt moves even when only the assignees changed.
    await tx.task.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'task.updated',
      target: id,
      data: { title: input.title ?? task.title, fields },
    });
    // Only the newly added assignees are told (Phase 9).
    const added = (input.assigneeIds ?? []).filter((u) => !task.assigneeIds.includes(u));
    if (fields.includes('assigneeIds') && added.length > 0) {
      await notify(tx, {
        type: 'task.assigned',
        projectId,
        userIds: added,
        actorId: access.userId,
        data: {
          taskId: id,
          title: input.title ?? task.title,
          actorName: await nameOf(tx, access.userId),
        },
      });
    }
  });
}

const invalidMove = () =>
  new HttpError(
    409,
    'invalid_move',
    'You can move your task only between To do and In progress; In review and Done follow its submissions',
  );

/**
 * POST /tasks/:taskId/move. Leads: any column (moving to Done sets `completedAt` and answers a
 * pending prompt). Assignees: between To do and In progress only (409 `invalid_move`). Others:
 * 403. Every manual move clears `reopenNote`.
 */
export async function moveTask(
  access: ProjectAccess,
  id: string,
  input: MoveTaskRequest,
): Promise<void> {
  const projectId = access.project.id;
  await inTx(async (tx) => {
    const task = await lockedTask(tx, projectId, id);
    const lead = isLead(access);
    const isAssignee = task.assigneeIds.includes(access.userId);
    if (!lead && !isAssignee) throw forbidden('Only its assignees and leaders can move this task');
    const allowed = allowedTaskMoves(task.status, { isLead: lead, isAssignee });
    if (!allowed.includes(input.status)) throw invalidMove();

    const from = task.status;
    const to = input.status;
    const statusChanged = from !== to;
    await tx.task.update({
      where: { id },
      data: {
        position: input.position,
        reopenNote: null,
        ...(statusChanged
          ? {
              status: to,
              // A lead moving the task decides it: any waiting "Mark this task done?" is answered.
              doneConfirmPending: false,
              completedAt: to === 'done' ? new Date() : null,
            }
          : {}),
      },
    });
    if (statusChanged) {
      await recordActivity(tx, {
        projectId,
        actorId: access.userId,
        action: 'task.moved',
        target: id,
        data: { title: task.title, from, to, automatic: false },
      });
    }
  });
}

/**
 * POST /tasks/:taskId/confirm-done — leads only, while `doneConfirmPending` (409 `not_pending`).
 * Yes → Done. Not yet → In progress, or stays In review while a linked submission is active.
 */
export async function confirmTaskDone(
  access: ProjectAccess,
  id: string,
  done: boolean,
): Promise<void> {
  const projectId = access.project.id;
  await inTx(async (tx) => {
    const task = await lockedTask(tx, projectId, id);
    if (!isLead(access)) throw forbidden('Only leaders and co-leaders can mark tasks done');
    if (!task.doneConfirmPending) {
      throw new HttpError(409, 'not_pending', 'This task isn’t waiting for confirmation');
    }
    const to: TaskStatus = done
      ? 'done'
      : (await hasActiveLinkedSubmission(tx, id))
        ? 'in_review'
        : 'in_progress';
    const moved = to !== task.status;
    await tx.task.update({
      where: { id },
      data: {
        doneConfirmPending: false,
        reopenNote: null,
        ...(moved
          ? {
              status: to,
              position: await bottomPosition(tx, projectId, to),
              completedAt: to === 'done' ? new Date() : null,
            }
          : {}),
      },
    });
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'task.done_confirmed',
      target: id,
      data: { title: task.title, done, from: task.status, to },
    });
  });
}

/** DELETE /tasks/:taskId — leads only. Linked submissions stay and lose the link. */
export async function deleteTask(access: ProjectAccess, id: string): Promise<void> {
  const projectId = access.project.id;
  await inTx(async (tx) => {
    const task = await lockedTask(tx, projectId, id);
    if (!isLead(access)) throw forbidden('Only leaders and co-leaders can delete tasks');
    await tx.task.delete({ where: { id } });
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'task.deleted',
      target: id,
      data: { title: task.title },
    });
  });
}
