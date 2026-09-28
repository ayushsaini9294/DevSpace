import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TaskStatus, TaskView } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { FocusHeading, LoadError, Loading, buttonStyles } from '../../../components/ui';
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  allowedColumns,
  columnTasks,
  isProjectLead,
  moveTargets,
  placeAtEnd,
  planDrop,
  taskErrorMessage,
  useMoveTask,
  useTasks,
  type DropTarget,
  type TaskPlace,
  type Viewer,
} from '../../../lib/tasks';
import { useProjectContext } from '../ProjectLayout';
import { DeleteTaskDialog, TaskDetailsDialog, TaskFormDialog } from './TaskDialogs';
import { AssigneeInitials, ConfirmDonePrompt, DueDate, MoveMenu } from './parts';

type Board = {
  projectId: string;
  viewer: Viewer;
  movePending: boolean;
  moveTo: (task: TaskView, status: TaskStatus) => void;
  open: (taskId: string) => void;
  report: (message: string) => void;
};

const COLUMN_PREFIX = 'column:';

function dropTarget(data: Record<string, unknown> | undefined): DropTarget | null {
  if (!data) return null;
  if (data.kind === 'column') return { kind: 'column', status: data.status as TaskStatus };
  if (data.kind === 'task') return { kind: 'task', taskId: data.taskId as string };
  return null;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a card shows; also the picture under the pointer while dragging. */
function CardBody({ task, board }: { task: TaskView; board: Board | null }) {
  const waiting = task.doneConfirmPending && !task.viewerActions.includes('confirmDone');
  return (
    <div className="space-y-2">
      {board ? (
        <button
          type="button"
          onClick={() => board.open(task.id)}
          className="block w-full text-left font-medium break-words text-gray-900 hover:text-blue-800 hover:underline focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
        >
          {task.title}
        </button>
      ) : (
        <p className="font-medium break-words text-gray-900">{task.title}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AssigneeInitials assignees={task.assignees} />
        <DueDate task={task} />
        {task.linkedSubmissions.length > 0 && (
          <span className="text-xs text-gray-600">
            {plural(task.linkedSubmissions.length, 'submission', 'submissions')}
          </span>
        )}
      </div>
      {task.reopenNote && (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-950">
          Reopened: {task.reopenNote}
        </p>
      )}
      {waiting && (
        <p className="text-xs text-gray-700">Merged. Waiting for a leader to mark it done.</p>
      )}
    </div>
  );
}

function TaskCard({ task, board }: { task: TaskView; board: Board }) {
  const targets = moveTargets(task, board.viewer);
  const canDrag = allowedColumns(task, board.viewer).length > 0;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { kind: 'task', taskId: task.id },
    disabled: { draggable: !canDrag, droppable: false },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`rounded-md border border-gray-200 bg-white p-3 shadow-sm ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start gap-2">
        {canDrag && (
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${task.title}`}
            className="mt-0.5 cursor-grab touch-none rounded px-1 text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
          >
            <span aria-hidden="true">⠿</span>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <CardBody task={task} board={board} />
        </div>
        <MoveMenu
          title={task.title}
          targets={targets}
          disabled={board.movePending}
          onMove={(status) => board.moveTo(task, status)}
        />
      </div>
      {task.viewerActions.includes('confirmDone') && (
        <div className="mt-2">
          <ConfirmDonePrompt projectId={board.projectId} taskId={task.id} onError={board.report} />
        </div>
      )}
    </li>
  );
}

function Column({
  status,
  tasks,
  board,
  highlight,
}: {
  status: TaskStatus;
  tasks: TaskView[];
  board: Board;
  /** The dragged card may land here. */
  highlight: boolean;
}) {
  const label = TASK_STATUS_LABELS[status];
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_PREFIX}${status}`,
    data: { kind: 'column', status },
  });
  return (
    <section
      aria-label={label}
      className={`flex min-w-0 flex-col rounded-lg border bg-gray-50 p-3 ${
        isOver && highlight
          ? 'border-blue-500 ring-2 ring-blue-200'
          : highlight
            ? 'border-blue-300'
            : 'border-gray-200'
      }`}
    >
      <h3 className="mb-2 flex items-center justify-between text-sm font-semibold text-gray-800">
        <span>{label}</span>
        <span className="rounded-full bg-gray-200 px-2 text-xs text-gray-700">
          <span className="sr-only">{plural(tasks.length, 'task', 'tasks')}</span>
          <span aria-hidden="true">{tasks.length}</span>
        </span>
      </h3>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} board={board} />
          ))}
        </ul>
      </SortableContext>
      {tasks.length === 0 && <p className="text-xs text-gray-500">No tasks.</p>}
    </section>
  );
}

function BoardView({ tasks }: { tasks: TaskView[] }) {
  const { project, me } = useProjectContext();
  const [params, setParams] = useSearchParams();
  const move = useMoveTask(project.id);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [dragging, setDragging] = useState<TaskView | null>(null);
  const [editing, setEditing] = useState<TaskView | null>(null);
  const [deleting, setDeleting] = useState<TaskView | null>(null);

  const viewer: Viewer = { id: me.id, isLead: isProjectLead(project) };
  const title = (id: unknown) => tasks.find((t) => t.id === id)?.title ?? 'the task';
  const columnName = (id: unknown) => {
    const s = String(id);
    if (s.startsWith(COLUMN_PREFIX)) {
      return `the ${TASK_STATUS_LABELS[s.slice(COLUMN_PREFIX.length) as TaskStatus]} column`;
    }
    const over = tasks.find((t) => t.id === s);
    return over ? `“${over.title}” in ${TASK_STATUS_LABELS[over.status]}` : 'here';
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up “${title(active.id)}”.`,
    onDragOver: ({ active, over }) =>
      over ? `“${title(active.id)}” is over ${columnName(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `“${title(active.id)}” was dropped on ${columnName(over.id)}.` : undefined,
    onDragCancel: ({ active }) => `Moving “${title(active.id)}” was cancelled.`,
  };

  function runMove(task: TaskView, place: TaskPlace) {
    setError(null);
    move.mutate(
      { id: task.id, ...place },
      {
        onSuccess: () => {
          setStatus(
            place.status === task.status
              ? `“${task.title}” reordered.`
              : `“${task.title}” moved to ${TASK_STATUS_LABELS[place.status]}.`,
          );
        },
        onError: (e) => setError(`Couldn’t move “${task.title}”. ${taskErrorMessage(e)}`),
      },
    );
  }

  function onDragStart({ active }: DragStartEvent) {
    setDragging(tasks.find((t) => t.id === active.id) ?? null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    const task = tasks.find((t) => t.id === active.id);
    const target = dropTarget(over?.data.current);
    if (!task || !target) return;
    const place = planDrop(tasks, task.id, target);
    if (!place) return;
    if (!allowedColumns(task, viewer).includes(place.status)) {
      setError(
        `“${task.title}” can’t be moved to ${TASK_STATUS_LABELS[place.status]}. ${
          viewer.isLead
            ? ''
            : 'You can move your tasks between To do and In progress; In review follows submitted work, and a leader marks tasks Done.'
        }`.trim(),
      );
      return;
    }
    runMove(task, place);
  }

  const openId = params.get('task');
  const openTask = openId ? (tasks.find((t) => t.id === openId) ?? null) : null;
  const closeDetails = () =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete('task');
        return next;
      },
      { replace: true },
    );

  const board: Board = {
    projectId: project.id,
    viewer,
    movePending: move.isPending,
    // The menu puts the task at the bottom of the chosen column.
    moveTo: (task, status) => runMove(task, placeAtEnd(tasks, task.id, status)),
    open: (taskId) => setParams({ task: taskId }),
    report: setError,
  };
  const dropAllowed = dragging ? allowedColumns(dragging, viewer) : [];

  return (
    <>
      {error && (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <FormAlert>{error}</FormAlert>
          </div>
          <button
            type="button"
            className={`${buttonStyles.secondary} py-1`}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ announcements }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TASK_STATUSES.map((s) => (
            <Column
              key={s}
              status={s}
              tasks={columnTasks(tasks, s)}
              board={board}
              highlight={dropAllowed.includes(s)}
            />
          ))}
        </div>
        <DragOverlay>
          {dragging && (
            <div className="rounded-md border border-blue-300 bg-white p-3 shadow-lg">
              <CardBody task={dragging} board={null} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {openId && !openTask && !editing && !deleting && (
        <p className="text-sm text-gray-700">That task no longer exists.</p>
      )}
      {openTask && !editing && !deleting && (
        <TaskDetailsDialog
          projectId={project.id}
          task={openTask}
          onClose={closeDetails}
          onEdit={() => setEditing(openTask)}
          onDelete={() => setDeleting(openTask)}
        />
      )}
      {editing && (
        <TaskFormDialog projectId={project.id} task={editing} onClose={() => setEditing(null)} />
      )}
      {deleting && (
        <DeleteTaskDialog
          projectId={project.id}
          task={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            closeDetails();
            setStatus(`“${deleting.title}” deleted.`);
          }}
        />
      )}
    </>
  );
}

/** `/projects/:projectId/tasks`: the task board. */
export function TasksPage() {
  const { project } = useProjectContext();
  const tasks = useTasks(project.id, { poll: true });
  const [creating, setCreating] = useState(false);
  const canCreate = project.allowedActions.includes('task.create');

  let body;
  if (tasks.isPending) {
    body = <Loading>Loading tasks…</Loading>;
  } else if (tasks.isError) {
    body = <LoadError what="the tasks" error={tasks.error} onRetry={() => tasks.refetch()} />;
  } else {
    body = <BoardView tasks={tasks.data} />;
  }

  return (
    <section aria-labelledby="tasks-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FocusHeading level={2}>
          <span id="tasks-heading">Tasks</span>
        </FocusHeading>
        {canCreate && (
          <button type="button" className={buttonStyles.primary} onClick={() => setCreating(true)}>
            New task
          </button>
        )}
      </div>
      <p className="text-sm text-gray-600">
        Drag a card, or use its Move menu. A task goes to In review when work linked to it is
        submitted; after the merge a leader marks it Done.
      </p>
      {body}
      {creating && (
        <TaskFormDialog projectId={project.id} task={null} onClose={() => setCreating(false)} />
      )}
    </section>
  );
}
