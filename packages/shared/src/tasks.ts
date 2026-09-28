import { z } from 'zod';
import { SubmissionStatusSchema, UserRefSchema } from './submissions.ts';
import { TaskStatusSchema, type TaskStatus } from './task-status.ts';

export * from './task-status.ts';

/**
 * Tasks (Phase 8). All routes are under /api/projects/:projectId and answer 404 `not_found`
 * for non-members and unknown tasks. Errors use ErrorResponseSchema. Live updates arrive in
 * Phase 9; until then the board refetches (about every 10 s and after every change).
 *
 * Automatic rules (run by the API with every submission change):
 * - a linked submission opens (submit, or an update that links the task) → `in_review`
 *   (a `done` task can't be linked: 409 `task_done`)
 * - a linked submission is merged → stays `in_review` with `doneConfirmPending` (leads confirm)
 * - a linked submission is rejected or closed and no other linked one is active → `in_progress`,
 *   unless a merge is waiting for confirmation
 * - a linked merged submission is undone → if `done` or waiting, back to `in_progress` with
 *   `reopenNote`; the note is cleared by the next manual move or confirmation
 */

// ---------- Limits ----------

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_DESCRIPTION = 10_000;
export const MAX_TASK_ASSIGNEES = 10;

/** Column order on the board. */
export const TASK_STATUSES = TaskStatusSchema.options;

/** Statuses an assignee (who isn't a leader or co-leader) may move their task between. */
export const ASSIGNEE_MOVE_STATUSES = [
  'todo',
  'in_progress',
] as const satisfies readonly TaskStatus[];

// ---------- Shared pieces ----------

export const TaskTitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a title')
  .max(MAX_TASK_TITLE, `Use at most ${MAX_TASK_TITLE} characters`);

export const TaskDescriptionSchema = z
  .string()
  .max(MAX_TASK_DESCRIPTION, `Use at most ${MAX_TASK_DESCRIPTION} characters`);

/** 1–10 distinct user ids; every one must be a current project member (else 400 on `assigneeIds`). */
export const TaskAssigneeIdsSchema = z
  .array(z.string().min(1).max(100))
  .min(1, 'Pick at least one assignee')
  .max(MAX_TASK_ASSIGNEES, `Pick at most ${MAX_TASK_ASSIGNEES} assignees`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each person may be picked once');

/** A calendar date `YYYY-MM-DD` (no time zone), or null for none. */
export const TaskDueDateSchema = z.iso.date('Enter a date as YYYY-MM-DD').nullable();

/** Order inside a column: lower comes first. Any finite number; the web app sends a value between the neighbours. */
export const TaskPositionSchema = z.number().finite();

/**
 * What the viewer may do on a task right now. The web app shows controls from this only.
 * - `edit`: leaders and co-leaders on any task; the creator on their own task while they still
 *   have `task.create` (title, description, assignees, due date)
 * - `move`: leaders and co-leaders (any column, reorder anywhere); an assignee while the task is
 *   in `todo` or `in_progress` (only between those two, see `allowedTaskMoves`)
 * - `delete`: leaders and co-leaders
 * - `confirmDone`: leaders and co-leaders while `doneConfirmPending` ("Mark this task done?")
 */
export const TaskViewerActionSchema = z.enum(['edit', 'move', 'delete', 'confirmDone']);

export const TaskLinkedSubmissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SubmissionStatusSchema,
});

export const TaskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  /** `YYYY-MM-DD` or null. */
  dueDate: z.iso.date().nullable(),
  position: z.number(),
  /** Sorted by name. */
  assignees: z.array(UserRefSchema),
  createdBy: UserRefSchema,
  /** A linked submission was merged and a lead hasn't answered "Mark this task done?" yet. */
  doneConfirmPending: z.boolean(),
  /** Why the task was reopened automatically (for example "Merge of 'X' was undone"), or null. */
  reopenNote: z.string().nullable(),
  /** Every submission linked to this task, newest first. */
  linkedSubmissions: z.array(TaskLinkedSubmissionSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** When it last became `done`; null while not done. */
  completedAt: z.iso.datetime().nullable(),
  viewerActions: z.array(TaskViewerActionSchema),
});

// ---------- Requests and responses ----------

/** GET /api/projects/:projectId/tasks — any member. Sorted by column, then `position`. */
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskViewSchema) });

/** Result of create, edit, move and confirm-done. */
export const TaskResponseSchema = z.object({ task: TaskViewSchema });

/**
 * POST /api/projects/:projectId/tasks — `task.create` (403 otherwise). 201 TaskResponse.
 * New tasks start in `todo`, at the bottom of the column.
 */
export const CreateTaskRequestSchema = z.object({
  title: TaskTitleSchema,
  description: TaskDescriptionSchema.default(''),
  assigneeIds: TaskAssigneeIdsSchema,
  dueDate: TaskDueDateSchema.optional(),
});

/**
 * PATCH /api/projects/:projectId/tasks/:taskId — `edit` (403 otherwise); send only what changes
 * (`dueDate: null` clears it). TaskResponse.
 */
export const UpdateTaskRequestSchema = z
  .object({
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.optional(),
    assigneeIds: TaskAssigneeIdsSchema.optional(),
    dueDate: TaskDueDateSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field');

/**
 * POST /api/projects/:projectId/tasks/:taskId/move — TaskResponse. Leaders and co-leaders move
 * any task anywhere (moving to `done` sets `completedAt` and answers a pending prompt). An
 * assignee moves between `todo` and `in_progress` only: any other move is 409 `invalid_move`.
 * Anyone else: 403. Every manual move clears `reopenNote`.
 */
export const MoveTaskRequestSchema = z.object({
  status: TaskStatusSchema,
  position: TaskPositionSchema,
});

/**
 * POST /api/projects/:projectId/tasks/:taskId/confirm-done — leaders and co-leaders (403
 * otherwise), only while `doneConfirmPending` (else 409 `not_pending`). `done: true` → `done`;
 * `done: false` ("Not yet") → `in_progress`, or stays `in_review` while a linked submission is
 * still active. Either way the prompt and `reopenNote` are cleared. TaskResponse.
 */
export const ConfirmTaskDoneRequestSchema = z.object({ done: z.boolean() });

// DELETE /api/projects/:projectId/tasks/:taskId (body `{}`) — leaders and co-leaders; 204.
// Linked submissions keep existing and lose their link.

/** Activity actions written for tasks. `task.moved` data: `{ title, from, to, automatic }`. */
export const TASK_ACTIVITY_ACTIONS = [
  'task.created',
  'task.updated',
  'task.moved',
  'task.deleted',
  'task.done_confirmed',
] as const;

// ---------- Helpers (the API enforces the same rules) ----------

/**
 * The columns this viewer may move a task to from `from`, including `from` itself (reordering).
 * Empty when they may not move it at all.
 */
export function allowedTaskMoves(
  from: TaskStatus,
  viewer: { isLead: boolean; isAssignee: boolean },
): TaskStatus[] {
  if (viewer.isLead) return [...TASK_STATUSES];
  if (viewer.isAssignee && (ASSIGNEE_MOVE_STATUSES as readonly string[]).includes(from)) {
    return [...ASSIGNEE_MOVE_STATUSES];
  }
  return [];
}

export type TaskViewerAction = z.infer<typeof TaskViewerActionSchema>;
export type TaskLinkedSubmission = z.infer<typeof TaskLinkedSubmissionSchema>;
export type TaskView = z.infer<typeof TaskViewSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>;
export type ConfirmTaskDoneRequest = z.infer<typeof ConfirmTaskDoneRequestSchema>;
export type TaskActivityAction = (typeof TASK_ACTIVITY_ACTIONS)[number];
