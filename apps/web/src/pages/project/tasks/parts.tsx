import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { TaskStatus, TaskView } from '@devspace/shared';
import { buttonStyles } from '../../../components/ui';
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
  formatDueDate,
  initials,
  isOverdue,
  taskErrorMessage,
  useConfirmTaskDone,
} from '../../../lib/tasks';

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TASK_STATUS_STYLES[status]}`}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

/** Round initials for each assignee; the full names are read out instead. */
export function AssigneeInitials({ assignees }: { assignees: TaskView['assignees'] }) {
  if (assignees.length === 0) return null;
  const names = assignees.map((a) => a.name).join(', ');
  return (
    <span className="flex flex-wrap gap-1">
      <span className="sr-only">Assigned to {names}</span>
      {assignees.map((a) => (
        <span
          key={a.id}
          aria-hidden="true"
          title={a.name}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-emphasis px-1 text-xs font-semibold text-fg"
        >
          {initials(a.name)}
        </span>
      ))}
    </span>
  );
}

/** "Due 28 Sept 2026", red with "overdue" when it has passed and the task isn't Done. */
export function DueDate({ task }: { task: Pick<TaskView, 'dueDate' | 'status'> }) {
  if (!task.dueDate) return null;
  const overdue = isOverdue(task);
  return (
    <span className={`text-xs ${overdue ? 'font-semibold text-danger-fg' : 'text-fg-muted'}`}>
      Due <time dateTime={task.dueDate}>{formatDueDate(task.dueDate)}</time>
      {overdue && ' (overdue)'}
    </span>
  );
}

/**
 * "Mark this task done?" with Yes / Not yet, for leads while a linked merge waits. A refusal is
 * reported to `onError` (the prompt itself may disappear when the board refreshes).
 */
export function ConfirmDonePrompt({
  projectId,
  taskId,
  onError,
  children,
}: {
  projectId: string;
  taskId: string;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
  const confirm = useConfirmTaskDone(projectId);
  const [answer, setAnswer] = useState<boolean | null>(null);
  const answerWith = (done: boolean) => {
    setAnswer(done);
    confirm.mutate({ id: taskId, done }, { onError: (error) => onError(taskErrorMessage(error)) });
  };
  return (
    <div className="space-y-2 rounded-md border border-success-line bg-success-soft p-2 text-sm text-success-strong">
      <p className="font-medium">Mark this task done?</p>
      {children}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${buttonStyles.primary} py-1`}
          disabled={confirm.isPending}
          aria-busy={(confirm.isPending && answer === true) || undefined}
          onClick={() => answerWith(true)}
        >
          Yes
        </button>
        <button
          type="button"
          className={`${buttonStyles.secondary} py-1`}
          disabled={confirm.isPending}
          aria-busy={(confirm.isPending && answer === false) || undefined}
          onClick={() => answerWith(false)}
        >
          Not yet
        </button>
      </div>
    </div>
  );
}

/**
 * The card's status menu: a "Move <title>" button that opens a menu of the columns this viewer
 * may move the task to. Arrow keys move between items, Escape closes.
 */
export function MoveMenu({
  title,
  targets,
  disabled,
  onMove,
}: {
  title: string;
  targets: TaskStatus[];
  disabled: boolean;
  onMove: (status: TaskStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  if (targets.length === 0) return null;
  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={`Move ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${buttonStyles.secondary} px-2 py-1 text-xs`}
      >
        Move <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={`Move ${title} to`}
          onKeyDown={onMenuKey}
          className="absolute right-0 z-20 mt-1 min-w-36 rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {targets.map((status) => (
            <button
              key={status}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                onMove(status);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-muted focus:bg-muted focus:outline-none"
            >
              {TASK_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
