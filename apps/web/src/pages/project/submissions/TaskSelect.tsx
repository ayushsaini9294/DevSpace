import { useId } from 'react';
import type { LinkedTask } from '@devspace/shared';
import { errorMessage } from '../../../lib/formErrors';
import { TASK_STATUS_LABELS, linkableTasks, useTasks } from '../../../lib/tasks';
import { useProjectContext } from '../ProjectLayout';

/**
 * The optional Task select on Submit work and Update: tasks that aren't Done, mine first. `''`
 * means no task. On Update, the currently linked task stays listed even if it is Done now.
 */
export function TaskSelect({
  projectId,
  value,
  onChange,
  current,
}: {
  projectId: string;
  value: string;
  onChange: (taskId: string) => void;
  current: LinkedTask | null;
}) {
  const { me } = useProjectContext();
  const tasks = useTasks(projectId);
  const id = useId();
  const hintId = `${id}-hint`;

  if (tasks.isError) {
    return (
      <p className="text-sm text-fg-soft">
        Could not load the tasks, so this can’t be linked to one now. {errorMessage(tasks.error)}{' '}
        <button
          type="button"
          className="font-medium text-accent-fg underline hover:text-accent-strong"
          onClick={() => tasks.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  const options = linkableTasks(tasks.data ?? [], me.id);
  const isMine = (t: (typeof options)[number]) => t.assignees.some((a) => a.id === me.id);
  const myTasks = options.filter(isMine);
  const otherTasks = options.filter((t) => !isMine(t));
  const keepCurrent = current !== null && !options.some((t) => t.id === current.id);

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        Task
      </label>
      <p id={hintId} className="text-sm text-fg-muted">
        Optional. The task moves to In review when this is submitted.
      </p>
      <select
        id={id}
        value={value}
        disabled={tasks.isPending}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="block w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-base shadow-card focus:border-accent focus:ring-4 focus:ring-accent-ring/40 focus:outline-none"
      >
        <option value="">No task</option>
        {keepCurrent && (
          <option value={current.id}>
            {current.title} ({TASK_STATUS_LABELS[current.status]})
          </option>
        )}
        {myTasks.length > 0 && (
          <optgroup label="My tasks">
            {myTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        )}
        {otherTasks.length > 0 && (
          <optgroup label={myTasks.length > 0 ? 'Other tasks' : 'Tasks'}>
            {otherTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {tasks.isPending && <p className="text-sm text-fg-muted">Loading tasks…</p>}
    </div>
  );
}
