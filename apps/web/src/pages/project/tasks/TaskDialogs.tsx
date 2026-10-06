import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  CreateTaskRequestSchema,
  type CreateTaskRequest,
  type TaskView,
  type UpdateTaskRequest,
} from '@devspace/shared';
import { TextField } from '../../../components/TextField';
import { Loading, buttonStyles, linkStyle } from '../../../components/ui';
import { describeServerError, errorMessage } from '../../../lib/formErrors';
import { useMembers } from '../../../lib/projects';
import { submissionUrl } from '../../../lib/submissions';
import {
  formatDueDate,
  isOverdue,
  taskErrorMessage,
  useCreateTask,
  useDeleteTask,
  useUpdateTask,
} from '../../../lib/tasks';
import { formatWhen, fullDate } from '../../../lib/time';
import { Dialog, StatusBadge, TextArea } from '../submissions/parts';
import { TaskStatusBadge } from './parts';

type Field = 'title' | 'description' | 'assigneeIds' | 'dueDate';
const FIELDS: readonly Field[] = ['title', 'description', 'assigneeIds', 'dueDate'];

function checkTask(values: CreateTaskRequest) {
  const result = CreateTaskRequestSchema.safeParse(values);
  if (result.success) return { ok: true as const, data: result.data };
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of result.error.issues) {
    const field = FIELDS.find((f) => f === issue.path[0]);
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { ok: false as const, errors };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** The New task dialog (no `task`) or the edit dialog for `task`. */
export function TaskFormDialog({
  projectId,
  task,
  onClose,
  onSaved,
}: {
  projectId: string;
  task: TaskView | null;
  onClose: () => void;
  onSaved?: (task: TaskView) => void;
}) {
  const members = useMembers(projectId);
  const create = useCreateTask(projectId);
  const update = useUpdateTask(projectId);
  const mutation = task ? update : create;

  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    () => task?.assignees.map((a) => a.id) ?? [],
  );
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  const server = describeServerError(mutation.error, FIELDS);
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];
  // A field error from the server is shown on its field; other refusals in words.
  const formError =
    mutation.isError && Object.keys(server.fieldErrors).length === 0
      ? taskErrorMessage(mutation.error)
      : null;

  function toggle(id: string) {
    setAssigneeIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
  }

  function submit() {
    const checked = checkTask({ title, description, assigneeIds, dueDate: dueDate || null });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const data = checked.data;
    const done = { onSuccess: (saved: TaskView) => (onSaved ? onSaved(saved) : onClose()) };
    if (!task) {
      create.mutate(data, done);
      return;
    }
    // Send only what changed.
    const changes: UpdateTaskRequest = {};
    if (data.title !== task.title) changes.title = data.title;
    if (data.description !== task.description) changes.description = data.description;
    if (
      !sameIds(
        data.assigneeIds,
        task.assignees.map((a) => a.id),
      )
    ) {
      changes.assigneeIds = data.assigneeIds;
    }
    if ((data.dueDate ?? null) !== task.dueDate) changes.dueDate = data.dueDate ?? null;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    update.mutate({ id: task.id, changes }, done);
  }

  const assigneeErrorId = useId();
  const assigneeError = fieldError('assigneeIds');
  let assigneePicker: ReactNode;
  if (members.isPending) {
    assigneePicker = <Loading>Loading members…</Loading>;
  } else if (members.isError) {
    assigneePicker = (
      <p className="text-sm text-danger-fg">
        Could not load the members. {errorMessage(members.error)}{' '}
        <button type="button" className={linkStyle} onClick={() => members.refetch()}>
          Try again
        </button>
      </p>
    );
  } else {
    assigneePicker = (
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2">
        {members.data.map((m) => (
          <label key={m.userId} className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={assigneeIds.includes(m.userId)}
              onChange={() => toggle(m.userId)}
              className="h-4 w-4 border-line-strong"
            />
            {m.name}
          </label>
        ))}
      </div>
    );
  }

  return (
    <Dialog
      title={task ? 'Edit task' : 'New task'}
      confirmLabel={task ? 'Save changes' : 'Create task'}
      pending={mutation.isPending}
      error={formError}
      onClose={onClose}
      onSubmit={submit}
    >
      <TextField
        label="Title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        error={fieldError('title')}
      />
      <TextArea
        label="Description"
        value={description}
        onChange={setDescription}
        rows={3}
        error={fieldError('description')}
      />
      <fieldset
        className="space-y-1"
        aria-describedby={assigneeError ? assigneeErrorId : undefined}
      >
        <legend className="text-sm font-medium text-fg">Assignees</legend>
        {assigneePicker}
        {assigneeError && (
          <p id={assigneeErrorId} className="text-sm text-danger-fg">
            {assigneeError}
          </p>
        )}
      </fieldset>
      <TextField
        label="Due date"
        name="dueDate"
        type="date"
        hint="Optional."
        value={dueDate}
        onChange={(event) => setDueDate(event.currentTarget.value)}
        error={fieldError('dueDate')}
      />
    </Dialog>
  );
}

export function DeleteTaskDialog({
  projectId,
  task,
  onClose,
  onDeleted,
}: {
  projectId: string;
  task: TaskView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteTask(projectId);
  return (
    <Dialog
      title="Delete this task?"
      confirmLabel="Delete task"
      confirmStyle={buttonStyles.danger}
      pending={remove.isPending}
      error={remove.isError ? taskErrorMessage(remove.error) : null}
      onClose={onClose}
      onSubmit={() => remove.mutate(task.id, { onSuccess: onDeleted })}
    >
      <p className="text-sm text-fg-soft">
        “{task.title}” is removed from the board. Submissions linked to it stay as they are, without
        a task.
      </p>
    </Dialog>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={fullDate.format(new Date(iso))}>
      {formatWhen(iso)}
    </time>
  );
}

/** A task's details: everything on the card plus description and linked submissions. */
export function TaskDetailsDialog({
  projectId,
  task,
  onClose,
  onEdit,
  onDelete,
}: {
  projectId: string;
  task: TaskView;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const canEdit = task.viewerActions.includes('edit');
  const canDelete = task.viewerActions.includes('delete');
  const overdue = isOverdue(task);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        className="max-h-full w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-pop focus:outline-none sm:p-6"
      >
        <div className="flex flex-wrap items-start gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg font-semibold break-words">
            {task.title}
          </h2>
          <TaskStatusBadge status={task.status} />
        </div>
        {task.reopenNote && (
          <p className="rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-strong">
            Reopened: {task.reopenNote}
          </p>
        )}
        {task.doneConfirmPending && (
          <p className="text-sm text-fg-soft">
            Linked work was merged. Waiting for a leader to mark this task done.
          </p>
        )}
        {task.description ? (
          <p className="break-words whitespace-pre-wrap text-fg">{task.description}</p>
        ) : (
          <p className="text-sm text-fg-muted">No description.</p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-muted">Assignees</dt>
          <dd className="text-fg">{task.assignees.map((a) => a.name).join(', ') || '—'}</dd>
          <dt className="text-fg-muted">Due</dt>
          <dd className={overdue ? 'font-semibold text-danger-fg' : 'text-fg'}>
            {task.dueDate ? (
              <>
                <time dateTime={task.dueDate}>{formatDueDate(task.dueDate)}</time>
                {overdue && ' (overdue)'}
              </>
            ) : (
              'No due date'
            )}
          </dd>
          <dt className="text-fg-muted">Created</dt>
          <dd className="text-fg">
            by {task.createdBy.name} <When iso={task.createdAt} />
          </dd>
          {task.completedAt && (
            <>
              <dt className="text-fg-muted">Done</dt>
              <dd className="text-fg">
                <When iso={task.completedAt} />
              </dd>
            </>
          )}
        </dl>
        <section aria-labelledby={`${titleId}-subs`} className="space-y-1">
          <h3 id={`${titleId}-subs`} className="font-medium text-fg">
            Linked submissions
          </h3>
          {task.linkedSubmissions.length === 0 ? (
            <p className="text-sm text-fg-muted">
              None yet. Pick this task when you submit work to link it.
            </p>
          ) : (
            <ul className="space-y-1">
              {task.linkedSubmissions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <Link to={submissionUrl(projectId, s.id)} className={`${linkStyle} break-words`}>
                    {s.title}
                  </Link>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          {canDelete && (
            <button type="button" className={buttonStyles.dangerOutline} onClick={onDelete}>
              Delete
            </button>
          )}
          {canEdit && (
            <button type="button" className={buttonStyles.secondary} onClick={onEdit}>
              Edit
            </button>
          )}
          <button type="button" className={buttonStyles.primary} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
