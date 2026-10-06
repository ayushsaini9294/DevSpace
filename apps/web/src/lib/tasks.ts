import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  TASK_STATUSES,
  TaskListResponseSchema,
  TaskResponseSchema,
  allowedTaskMoves,
  type CreateTaskRequest,
  type ProjectDetail,
  type TaskStatus,
  type TaskView,
  type UpdateTaskRequest,
} from '@devspace/shared';
import { ApiError, apiDelete, apiFetch, apiPatch, apiPost } from './api';
import { errorMessage } from './formErrors';
import { usePollInterval } from './liveStore';
import { queryKeys } from './projects';
import { submissionKeys } from './submissions';

const enc = encodeURIComponent;

/** The board refetches this often without a live connection (60 s with one). */
export const BOARD_REFRESH_MS = 10_000;

export const taskKeys = {
  list: submissionKeys.tasks,
};

// ---------- URLs ----------

export function tasksUrl(projectId: string): string {
  return `/projects/${projectId}/tasks`;
}

/** The board with one task's details open. */
export function taskUrl(projectId: string, taskId: string): string {
  return `/projects/${projectId}/tasks?task=${enc(taskId)}`;
}

function api(projectId: string, rest: string): string {
  return `/api/projects/${enc(projectId)}${rest}`;
}

// ---------- Queries ----------

/** Every task in the project. `poll` refetches about every 10 s (60 s while live). */
export function useTasks(projectId: string, { poll = false }: { poll?: boolean } = {}) {
  const interval = usePollInterval(BOARD_REFRESH_MS);
  return useQuery({
    queryKey: taskKeys.list(projectId),
    queryFn: async () =>
      TaskListResponseSchema.parse(await apiFetch(api(projectId, '/tasks'))).tasks,
    refetchInterval: poll ? interval : false,
  });
}

// ---------- Mutations ----------

/** Put the fresh task into the list, then refetch the board, submissions and activity. */
function taskChanged(queryClient: QueryClient, projectId: string, task: TaskView | null) {
  if (task) {
    queryClient.setQueryData<TaskView[]>(taskKeys.list(projectId), (tasks) => {
      if (!tasks) return tasks;
      return tasks.some((t) => t.id === task.id)
        ? tasks.map((t) => (t.id === task.id ? task : t))
        : [...tasks, task];
    });
  }
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: taskKeys.list(projectId) }),
    // Submissions show their task's title and status.
    queryClient.invalidateQueries({ queryKey: submissionKeys.all(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
  ]);
}

function useTaskMutation<T>(projectId: string, request: (data: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: T) => TaskResponseSchema.parse(await request(data)).task,
    onSuccess: (task) => taskChanged(queryClient, projectId, task),
  });
}

export function useCreateTask(projectId: string) {
  return useTaskMutation(projectId, (data: CreateTaskRequest) =>
    apiPost(api(projectId, '/tasks'), data),
  );
}

export function useUpdateTask(projectId: string) {
  return useTaskMutation(projectId, ({ id, changes }: { id: string; changes: UpdateTaskRequest }) =>
    apiPatch(api(projectId, `/tasks/${enc(id)}`), changes),
  );
}

/** Answer "Mark this task done?". A refusal (e.g. `not_pending`) re-reads the board and submissions. */
export function useConfirmTaskDone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) =>
      TaskResponseSchema.parse(
        await apiPost(api(projectId, `/tasks/${enc(id)}/confirm-done`), { done }),
      ).task,
    onSuccess: (task) => taskChanged(queryClient, projectId, task),
    // Not awaited: the prompt may vanish with the refetch, so the caller hears of the error first.
    onError: () => {
      void taskChanged(queryClient, projectId, null);
    },
  });
}

export function useDeleteTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(api(projectId, `/tasks/${enc(id)}`));
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<TaskView[]>(taskKeys.list(projectId), (tasks) =>
        tasks?.filter((t) => t.id !== id),
      );
      return taskChanged(queryClient, projectId, null);
    },
  });
}

/**
 * Move a task. The card moves at once; a refused move puts the board back as it was (the card
 * snaps back) and the caller shows the error.
 */
export function useMoveTask(projectId: string) {
  const queryClient = useQueryClient();
  const key = taskKeys.list(projectId);
  return useMutation({
    mutationFn: async ({ id, status, position }: { id: string } & TaskPlace) =>
      TaskResponseSchema.parse(
        await apiPost(api(projectId, `/tasks/${enc(id)}/move`), { status, position }),
      ).task,
    onMutate: async ({ id, status, position }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TaskView[]>(key);
      queryClient.setQueryData<TaskView[]>(key, (tasks) =>
        tasks?.map((t) => (t.id === id ? { ...t, status, position } : t)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      return queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: (task) => taskChanged(queryClient, projectId, task),
  });
}

// ---------- Board rules ----------

export { TASK_STATUSES };

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

export const TASK_STATUS_STYLES: Record<TaskStatus, string> = {
  todo: 'bg-muted text-fg border-line-strong',
  in_progress: 'bg-accent-soft text-accent-fg border-accent-line',
  in_review: 'bg-warning-soft text-warning-strong border-warning-line',
  done: 'bg-success-soft text-success-fg border-success-line',
};

/** Leaders and co-leaders: move any task anywhere, edit and delete any task. */
export function isProjectLead(project: ProjectDetail): boolean {
  return project.allowedActions.includes('submission.merge');
}

export type Viewer = { id: string; isLead: boolean };

/**
 * The columns this viewer may drop the task in, including its own (a reorder): the shared rule
 * (leads anywhere; assignees between To do and In progress), and only with `move` in the task's
 * viewerActions.
 */
export function allowedColumns(task: TaskView, viewer: Viewer): TaskStatus[] {
  if (!task.viewerActions.includes('move')) return [];
  return allowedTaskMoves(task.status, {
    isLead: viewer.isLead,
    isAssignee: task.assignees.some((a) => a.id === viewer.id),
  });
}

/** The other columns the status menu offers. */
export function moveTargets(task: TaskView, viewer: Viewer): TaskStatus[] {
  return allowedColumns(task, viewer).filter((s) => s !== task.status);
}

export type TaskPlace = { status: TaskStatus; position: number };

/** Tasks in one column, in board order. */
export function columnTasks(tasks: TaskView[], status: TaskStatus): TaskView[] {
  return tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The position for a task placed at `index` in a column (whose list excludes the task itself):
 * halfway between its new neighbours, one past the end, one before the start, or 1 when empty.
 */
export function positionAt(column: TaskView[], index: number): number {
  const before = column[index - 1];
  const after = column[index];
  if (before && after) return (before.position + after.position) / 2;
  if (before) return before.position + 1;
  if (after) return after.position - 1;
  return 1;
}

/** Placing a task at the end of a column (the status menu does this). */
export function placeAtEnd(tasks: TaskView[], taskId: string, status: TaskStatus): TaskPlace {
  const column = columnTasks(tasks, status).filter((t) => t.id !== taskId);
  return { status, position: positionAt(column, column.length) };
}

/** A drop target: a column (then the end of it) or another card (then that card's place). */
export type DropTarget = { kind: 'column'; status: TaskStatus } | { kind: 'task'; taskId: string };

/**
 * Where a drag of `taskId` onto `target` puts it, or null when nothing changes. Dropping on a
 * card in the same column takes that card's place (moving down puts it after, like a list);
 * in another column it goes before that card.
 */
export function planDrop(tasks: TaskView[], taskId: string, target: DropTarget): TaskPlace | null {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  if (target.kind === 'column') {
    if (target.status === task.status) return null;
    return placeAtEnd(tasks, taskId, target.status);
  }
  if (target.taskId === taskId) return null;
  const over = tasks.find((t) => t.id === target.taskId);
  if (!over) return null;
  const full = columnTasks(tasks, over.status);
  const column = full.filter((t) => t.id !== taskId);
  let index = column.findIndex((t) => t.id === over.id);
  if (over.status === task.status) {
    const from = full.findIndex((t) => t.id === taskId);
    const to = full.findIndex((t) => t.id === over.id);
    if (from < to) index += 1;
  }
  return { status: over.status, position: positionAt(column, index) };
}

// ---------- Display ----------

/** "AL" for "Ada Lovelace", "G" for "Grace". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The YYYY-MM-DD part of a due date. */
export function dueDay(dueDate: string): string {
  return dueDate.slice(0, 10);
}

/** Overdue: the due day is before today and the task isn't Done. */
export function isOverdue(task: Pick<TaskView, 'dueDate' | 'status'>, now = new Date()): boolean {
  return task.dueDate !== null && task.status !== 'done' && dueDay(task.dueDate) < todayIso(now);
}

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

/** "28 Sept 2026" for a due date (a calendar day, so no time zone shift). */
export function formatDueDate(dueDate: string): string {
  const day = dueDay(dueDate);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dayFormat.format(date);
}

/** Tasks that can take a submission (not Done), mine first, then by title. */
export function linkableTasks(tasks: TaskView[], myId: string): TaskView[] {
  const mine = (t: TaskView) => (t.assignees.some((a) => a.id === myId) ? 0 : 1);
  return tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => mine(a) - mine(b) || a.title.localeCompare(b.title));
}

/** Clear words for the API's task error codes; the server's message otherwise. */
export function taskErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.errorResponse?.error : undefined;
  switch (code) {
    case 'invalid_move':
      return 'You can only move your tasks between To do and In progress. A task goes to In review when work linked to it is submitted, and only a leader can mark it Done.';
    case 'task_done':
      return 'That task is already Done, so new work can’t be linked to it. Pick another task, or ask a leader to reopen it.';
    case 'not_pending':
      return 'This task is no longer waiting for a decision (someone may have answered already). The board has been refreshed.';
    case 'forbidden':
      return 'You don’t have permission to do that.';
    case 'validation_error': {
      const fields = error instanceof ApiError ? error.errorResponse?.fields : undefined;
      const first = fields ? Object.values(fields).flat()[0] : undefined;
      return first ?? errorMessage(error);
    }
    default:
      if (error instanceof ApiError && error.status === 404) {
        return 'This task no longer exists, or you are no longer in the project.';
      }
      return errorMessage(error);
  }
}
