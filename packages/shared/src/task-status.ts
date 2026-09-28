import { z } from 'zod';

/**
 * The pieces of Tasks (Phase 8) that submissions also need. Kept apart from `tasks.ts` so
 * `submissions.ts` and `tasks.ts` don't import each other. Re-exported by `tasks.ts`.
 */

/** Board columns, in order. */
export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'in_review', 'done']);

/** A task as shown on a submission (list and review page). */
export const LinkedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
});

/**
 * `taskId` on submission create and update. On update, `null` unlinks and a missing field keeps
 * the link. The task must be in the same project (else 400 `validation_error` on `taskId`) and
 * not `done` (409 `task_done`).
 */
export const SubmissionTaskIdSchema = z.string().min(1, 'Pick a task').max(100).nullable();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type LinkedTask = z.infer<typeof LinkedTaskSchema>;
