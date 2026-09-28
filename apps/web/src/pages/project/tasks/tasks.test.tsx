import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateSubmissionRequestSchema,
  CreateTaskRequestSchema,
  MoveTaskRequestSchema,
  UpdateSubmissionRequestSchema,
  type ActivityEntry,
  type TaskView,
} from '@devspace/shared';
import { describeActivity } from '../../../lib/labels';
import {
  allowedColumns,
  initials,
  isOverdue,
  moveTargets,
  planDrop,
  positionAt,
} from '../../../lib/tasks';
import {
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testMember,
  testProject,
  testSubmission,
  testTask,
  testUser,
  type StubReply,
  type StubRoutes,
} from '../../../test/utils';

// Monaco doesn't run in jsdom; these tests don't look at diffs.
vi.mock('../../../components/code/DiffViewer', () => ({
  default: () => <div data-testid="diff-mock" />,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const BOARD = '/projects/project-1/tasks';
const me = { id: testUser.id, name: testUser.name };
const grace = { id: 'user-2', name: 'Grace Hopper' };

function base(role: 'leader' | 'co_leader' | 'member', extra: StubRoutes): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: {
      status: 200,
      body: {
        project: testProject(role, {
          myPermissions: {
            approve: false,
            comment: false,
            createTasks: role !== 'member',
            aiReview: false,
            publishGithub: false,
          },
        }),
      },
    },
    [`GET ${P}/members`]: {
      status: 200,
      body: {
        members: [
          testMember(testUser.id, testUser.name, role),
          testMember(grace.id, grace.name, 'member'),
        ],
      },
    },
    ...extra,
  };
}

/** GET /tasks answering whatever `state.tasks` is now. */
function liveTasks(state: { tasks: TaskView[] }): () => StubReply {
  return () => ({ status: 200, body: { tasks: state.tasks } });
}

const column = (name: string) => screen.getByRole('region', { name });
const card = (title: string) =>
  screen.getAllByRole('listitem').find((li) => li.textContent?.includes(title))!;

// ---------- Rules ----------

describe('board rules', () => {
  const t = (id: string, status: TaskView['status'], position: number) =>
    testTask({ id, title: id, status, position });

  it('places a dragged card between its new neighbours', () => {
    const tasks = [t('a', 'todo', 1), t('b', 'todo', 2), t('c', 'todo', 3), t('d', 'done', 5)];
    // Down onto c: after c.
    expect(planDrop(tasks, 'a', { kind: 'task', taskId: 'c' })).toEqual({
      status: 'todo',
      position: 4,
    });
    // Up onto a: before a.
    expect(planDrop(tasks, 'c', { kind: 'task', taskId: 'a' })).toEqual({
      status: 'todo',
      position: 0,
    });
    // Onto b from below: between a and b.
    expect(planDrop(tasks, 'c', { kind: 'task', taskId: 'b' })).toEqual({
      status: 'todo',
      position: 1.5,
    });
    // Onto another column's card: before it.
    expect(planDrop(tasks, 'a', { kind: 'task', taskId: 'd' })).toEqual({
      status: 'done',
      position: 4,
    });
    // Onto a column: its bottom; an empty one gets 1.
    expect(planDrop(tasks, 'a', { kind: 'column', status: 'done' })).toEqual({
      status: 'done',
      position: 6,
    });
    expect(planDrop(tasks, 'a', { kind: 'column', status: 'in_review' })).toEqual({
      status: 'in_review',
      position: 1,
    });
    // No change.
    expect(planDrop(tasks, 'a', { kind: 'column', status: 'todo' })).toBeNull();
    expect(planDrop(tasks, 'a', { kind: 'task', taskId: 'a' })).toBeNull();
    expect(positionAt([], 0)).toBe(1);
  });

  it('offers assignees only To do ↔ In progress, and leads every column', () => {
    const viewer = { id: me.id, isLead: false };
    const lead = { id: 'user-9', isLead: true };
    const mine = testTask({ status: 'todo', viewerActions: ['move'] });
    expect(moveTargets(mine, viewer)).toEqual(['in_progress']);
    expect(allowedColumns(mine, viewer)).toEqual(['todo', 'in_progress']);
    expect(moveTargets({ ...mine, status: 'in_progress' }, viewer)).toEqual(['todo']);
    // Without `move`, nothing (e.g. an assignee's task in review).
    expect(moveTargets({ ...mine, status: 'in_review', viewerActions: [] }, viewer)).toEqual([]);
    expect(moveTargets({ ...mine, status: 'done' }, lead)).toEqual([
      'todo',
      'in_progress',
      'in_review',
    ]);
  });

  it('shows initials and knows when a task is overdue', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace')).toBe('G');
    const now = new Date(2026, 8, 28, 12);
    expect(isOverdue({ dueDate: '2026-09-27', status: 'todo' }, now)).toBe(true);
    expect(isOverdue({ dueDate: '2026-09-28', status: 'todo' }, now)).toBe(false);
    expect(isOverdue({ dueDate: '2026-09-27', status: 'done' }, now)).toBe(false);
  });
});

// ---------- Board ----------

describe('Tasks board', () => {
  it('shows four columns and cards with initials, due date, linked count and reopen note', async () => {
    stubApi(
      base('member', {
        [`GET ${P}/tasks`]: {
          status: 200,
          body: {
            tasks: [
              testTask({
                id: 't1',
                title: 'Old work',
                status: 'in_progress',
                dueDate: '2020-01-02',
                assignees: [me, grace],
                reopenNote: "Merge of 'Login' was undone",
                linkedSubmissions: [
                  { id: 's1', title: 'Login', status: 'reverted' },
                  { id: 's2', title: 'Login again', status: 'open' },
                ],
              }),
              testTask({ id: 't2', title: 'Finished', status: 'done', dueDate: '2020-01-02' }),
            ],
          },
        },
      }),
    );
    renderApp(BOARD);

    const names = ['To do', 'In progress', 'In review', 'Done'];
    for (const name of names) expect(await screen.findByRole('region', { name })).toBeVisible();
    // The Tasks tab is current.
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');

    const old = within(column('In progress')).getByRole('listitem');
    expect(old).toHaveTextContent('Old work');
    expect(old).toHaveTextContent('Assigned to Ada Lovelace, Grace Hopper');
    expect(old).toHaveTextContent('AL');
    expect(old).toHaveTextContent('GH');
    expect(old).toHaveTextContent('(overdue)');
    expect(old).toHaveTextContent('2 submissions');
    expect(old).toHaveTextContent("Reopened: Merge of 'Login' was undone");
    // Done tasks are never overdue.
    expect(within(column('Done')).getByRole('listitem')).not.toHaveTextContent('overdue');
    // A member without Create tasks gets no New task button.
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('lets an assignee move their task with the card menu, offering only allowed moves', async () => {
    const user = userEvent.setup();
    const state = {
      tasks: [
        testTask({ id: 't1', title: 'Build it', viewerActions: ['move'] }),
        testTask({ id: 't2', title: 'Someone else’s', assignees: [grace] }),
      ],
    };
    const fetchMock = stubApi(
      base('member', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`POST ${P}/tasks/t1/move`]: () => {
          const moved = { ...state.tasks[0]!, status: 'in_progress' as const, position: 1 };
          state.tasks = [moved, state.tasks[1]!];
          return { status: 200, body: { task: moved } };
        },
      }),
    );
    renderApp(BOARD);

    await screen.findByText('Build it');
    // No menu (and no drag handle) on a task I can't move.
    expect(
      within(card('Someone else’s')).queryByRole('button', { name: /^Move/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drag Someone else’s' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Build it' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move Build it' }));
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['In progress']);
    // Keyboard: the first item has focus; Escape closes and returns focus.
    expect(within(menu).getByRole('menuitem', { name: 'In progress' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Build it' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Move Build it' }));
    await user.click(screen.getByRole('menuitem', { name: 'In progress' }));

    await waitFor(() =>
      expect(within(column('In progress')).getByRole('listitem')).toHaveTextContent('Build it'),
    );
    expect(MoveTaskRequestSchema.parse(requestBody(fetchMock, `POST ${P}/tasks/t1/move`))).toEqual({
      status: 'in_progress',
      position: 1,
    });
    expect(screen.getByText('“Build it” moved to In progress.')).toHaveAttribute('role', 'status');
  });

  it('snaps a refused move back and says why', async () => {
    const user = userEvent.setup();
    const state = { tasks: [testTask({ id: 't1', title: 'Build it', viewerActions: ['move'] })] };
    stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`POST ${P}/tasks/t1/move`]: {
          status: 409,
          body: { error: 'invalid_move', message: 'Not allowed' },
        },
      }),
    );
    renderApp(BOARD);

    await user.click(await screen.findByRole('button', { name: 'Move Build it' }));
    // A lead is offered every other column.
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'In progress',
      'In review',
      'Done',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Done' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t move “Build it”. You can only move your tasks between To do and In progress.',
    );
    expect(within(column('To do')).getByRole('listitem')).toHaveTextContent('Build it');
    expect(within(column('Done')).queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('lets a leader answer “Mark this task done?”; a member sees no prompt', async () => {
    const user = userEvent.setup();
    const waiting = testTask({
      id: 't1',
      title: 'Build it',
      status: 'in_review',
      doneConfirmPending: true,
      viewerActions: ['move', 'edit', 'delete', 'confirmDone'],
    });
    const state = { tasks: [waiting] };
    const fetchMock = stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`POST ${P}/tasks/t1/confirm-done`]: () => {
          state.tasks = [
            {
              ...waiting,
              status: 'done',
              doneConfirmPending: false,
              viewerActions: ['move', 'edit', 'delete'],
            },
          ];
          return { status: 200, body: { task: state.tasks[0]! } };
        },
      }),
    );
    renderApp(BOARD);

    const waitingCard = await waitFor(() => card('Build it'));
    expect(waitingCard).toHaveTextContent('Mark this task done?');
    await user.click(within(waitingCard).getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(within(column('Done')).getByRole('listitem')).toHaveTextContent('Build it'),
    );
    expect(requestBody(fetchMock, `POST ${P}/tasks/t1/confirm-done`)).toEqual({ done: true });
    expect(screen.queryByText('Mark this task done?')).not.toBeInTheDocument();
  });

  it('shows a member a waiting task without Yes / Not yet', async () => {
    stubApi(
      base('member', {
        [`GET ${P}/tasks`]: {
          status: 200,
          body: {
            tasks: [testTask({ title: 'Build it', status: 'in_review', doneConfirmPending: true })],
          },
        },
      }),
    );
    renderApp(BOARD);
    expect(
      await screen.findByText('Merged. Waiting for a leader to mark it done.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Mark this task done?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not yet' })).not.toBeInTheDocument();
  });

  it('explains not_pending when someone already answered', async () => {
    const user = userEvent.setup();
    stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: {
          status: 200,
          body: {
            tasks: [
              testTask({
                id: 't1',
                title: 'Build it',
                status: 'in_review',
                doneConfirmPending: true,
                viewerActions: ['confirmDone'],
              }),
            ],
          },
        },
        [`POST ${P}/tasks/t1/confirm-done`]: {
          status: 409,
          body: { error: 'not_pending', message: 'Not pending' },
        },
      }),
    );
    renderApp(BOARD);
    await user.click(await screen.findByRole('button', { name: 'Not yet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This task is no longer waiting for a decision',
    );
  });
});

// ---------- Dialogs ----------

describe('Task dialogs', () => {
  it('creates a task with assignees and a due date, after checking the form', async () => {
    const user = userEvent.setup();
    const state = { tasks: [] as TaskView[] };
    const fetchMock = stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`POST ${P}/tasks`]: () => {
          const task = testTask({ id: 't9', title: 'Write docs', assignees: [grace] });
          state.tasks = [task];
          return { status: 201, body: { task } };
        },
      }),
    );
    renderApp(BOARD);

    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByLabelText('Title')).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(dialog).toHaveTextContent('Enter a title');
    expect(dialog).toHaveTextContent('Pick at least one assignee');

    await user.type(within(dialog).getByLabelText('Title'), 'Write docs');
    await user.type(within(dialog).getByLabelText('Description'), 'For the API');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Grace Hopper' }));
    await user.type(within(dialog).getByLabelText('Due date'), '2026-10-01');
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(CreateTaskRequestSchema.parse(requestBody(fetchMock, `POST ${P}/tasks`))).toEqual({
      title: 'Write docs',
      description: 'For the API',
      assigneeIds: [grace.id],
      dueDate: '2026-10-01',
    });
    expect(within(column('To do')).getByRole('listitem')).toHaveTextContent('Write docs');
  });

  it('shows a server field error on the assignees', async () => {
    const user = userEvent.setup();
    stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: { status: 200, body: { tasks: [] } },
        [`POST ${P}/tasks`]: {
          status: 400,
          body: {
            error: 'validation_error',
            message: 'Check the form',
            fields: { assigneeIds: ['Grace Hopper is no longer in this project'] },
          },
        },
      }),
    );
    renderApp(BOARD);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    await user.type(within(dialog).getByLabelText('Title'), 'Write docs');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Grace Hopper' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(
      await within(dialog).findByText('Grace Hopper is no longer in this project'),
    ).toBeInTheDocument();
  });

  it('opens details with linked submissions, and edits only what changed', async () => {
    const user = userEvent.setup();
    const task = testTask({
      id: 't1',
      title: 'Build it',
      description: 'The login form',
      dueDate: '2026-10-01',
      assignees: [me],
      linkedSubmissions: [{ id: 'sub-1', title: 'Add the login page', status: 'open' }],
      viewerActions: ['edit', 'move', 'delete'],
    });
    const state = { tasks: [task] };
    const fetchMock = stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`PATCH ${P}/tasks/t1`]: () => {
          state.tasks = [{ ...task, dueDate: null, assignees: [me, grace] }];
          return { status: 200, body: { task: state.tasks[0]! } };
        },
      }),
    );
    renderApp(`${BOARD}?task=t1`);

    const details = await screen.findByRole('dialog', { name: 'Build it' });
    expect(details).toHaveTextContent('The login form');
    expect(within(details).getByRole('link', { name: 'Add the login page' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/sub-1',
    );
    await user.click(within(details).getByRole('button', { name: 'Edit' }));

    const edit = screen.getByRole('dialog', { name: 'Edit task' });
    expect(within(edit).getByLabelText('Title')).toHaveValue('Build it');
    await user.click(await within(edit).findByRole('checkbox', { name: 'Grace Hopper' }));
    await user.clear(within(edit).getByLabelText('Due date'));
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).not.toBeInTheDocument(),
    );
    expect(requestBody(fetchMock, `PATCH ${P}/tasks/t1`)).toEqual({
      assigneeIds: [me.id, grace.id],
      dueDate: null,
    });
  });

  it('deletes a task after confirming', async () => {
    const user = userEvent.setup();
    const state = {
      tasks: [testTask({ id: 't1', title: 'Build it', viewerActions: ['edit', 'delete'] })],
    };
    stubApi(
      base('leader', {
        [`GET ${P}/tasks`]: liveTasks(state),
        [`DELETE ${P}/tasks/t1`]: () => {
          state.tasks = [];
          return { status: 204 };
        },
      }),
    );
    renderApp(BOARD);
    await user.click(await screen.findByRole('button', { name: 'Build it' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Build it')).not.toBeInTheDocument();
  });
});

// ---------- Submissions ----------

describe('Tasks on submissions', () => {
  const changes = {
    [`GET ${P}/copy/changes`]: {
      status: 200,
      body: {
        baseSha: 'a'.repeat(40),
        files: [{ path: 'src/app.ts', change: 'modified', openSubmissionId: null }],
      },
    },
  } satisfies StubRoutes;

  it('offers a Task select on Submit work (not Done, mine first) and sends the pick', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      base('member', {
        ...changes,
        [`GET ${P}/tasks`]: {
          status: 200,
          body: {
            tasks: [
              testTask({ id: 't-other', title: 'A task for Grace', assignees: [grace] }),
              testTask({ id: 't-mine', title: 'Zebra task of mine', status: 'in_progress' }),
              testTask({ id: 't-done', title: 'Finished task', status: 'done' }),
            ],
          },
        },
        [`POST ${P}/submissions`]: {
          status: 201,
          body: { submission: testSubmission() },
        },
        [`GET ${P}/submissions/sub-1`]: { status: 200, body: { submission: testSubmission() } },
      }),
    );
    renderApp('/projects/project-1/submissions/new');

    const select = await screen.findByRole('combobox', { name: /^Task/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['No task', 'Zebra task of mine', 'A task for Grace']);
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'Zebra task of mine');
    await user.type(screen.getByLabelText('Title'), 'My work');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(
        CreateSubmissionRequestSchema.parse(requestBody(fetchMock, `POST ${P}/submissions`)),
      ).toEqual({
        title: 'My work',
        description: '',
        paths: ['src/app.ts'],
        taskId: 't-mine',
      }),
    );
  });

  it('says so when the picked task is already Done', async () => {
    const user = userEvent.setup();
    stubApi(
      base('member', {
        ...changes,
        [`GET ${P}/tasks`]: { status: 200, body: { tasks: [testTask({ id: 't1' })] } },
        [`POST ${P}/submissions`]: {
          status: 409,
          body: { error: 'task_done', message: 'Task is done' },
        },
      }),
    );
    renderApp('/projects/project-1/submissions/new?task=t1');
    const select = await screen.findByRole('combobox', { name: /^Task/ });
    await waitFor(() => expect(select).toHaveValue('t1'));
    await user.type(screen.getByLabelText('Title'), 'My work');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That task is already Done');
  });

  it('unlinks on Update with No task, and sends nothing about the task when unchanged', async () => {
    const user = userEvent.setup();
    const mine = testSubmission({
      author: me,
      viewerActions: ['update'],
      task: { id: 't1', title: 'Build it', status: 'in_review' },
    });
    const fetchMock = stubApi(
      base('member', {
        ...changes,
        [`GET ${P}/submissions/sub-1`]: { status: 200, body: { submission: mine } },
        [`GET ${P}/tasks`]: {
          status: 200,
          body: { tasks: [testTask({ id: 't1', title: 'Build it', status: 'in_review' })] },
        },
        [`POST ${P}/submissions/sub-1/update`]: { status: 200, body: { submission: mine } },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1/update');
    const select = await screen.findByRole('combobox', { name: /^Task/ });
    await waitFor(() => expect(select).toHaveValue('t1'));
    await user.selectOptions(select, 'No task');
    await user.click(screen.getByRole('button', { name: 'Update submission' }));
    await waitFor(() =>
      expect(
        UpdateSubmissionRequestSchema.parse(
          requestBody(fetchMock, `POST ${P}/submissions/sub-1/update`),
        ),
      ).toMatchObject({ taskId: null }),
    );
  });

  it('shows the linked task on the review page, and asks a leader after the merge', async () => {
    const user = userEvent.setup();
    const task = { id: 't1', title: 'Build it', status: 'in_review' as const };
    const state = {
      current: testSubmission({
        status: 'merged',
        mergeBlocker: 'not_active',
        viewerActions: ['revert', 'confirmTaskDone'],
        task,
      }),
    };
    const fetchMock = stubApi(
      base('leader', {
        [`GET ${P}/submissions/sub-1`]: () => ({
          status: 200,
          body: { submission: state.current },
        }),
        [`POST ${P}/tasks/t1/confirm-done`]: () => {
          state.current = {
            ...state.current,
            viewerActions: ['revert'],
            task: { ...task, status: 'in_progress' },
          };
          return {
            status: 200,
            body: { task: testTask({ id: 't1', title: 'Build it', status: 'in_progress' }) },
          };
        },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    expect(await screen.findByRole('link', { name: 'Build it' })).toHaveAttribute(
      'href',
      '/projects/project-1/tasks?task=t1',
    );
    expect(screen.getByText('Mark this task done?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(screen.queryByText('Mark this task done?')).not.toBeInTheDocument());
    expect(requestBody(fetchMock, `POST ${P}/tasks/t1/confirm-done`)).toEqual({ done: false });
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('shows the linked task in the submission list', async () => {
    stubApi(
      base('member', {
        [`GET ${P}/submissions?status=active`]: {
          status: 200,
          body: {
            submissions: [
              { ...testSubmission(), task: { id: 't1', title: 'Build it', status: 'in_review' } },
            ],
          },
        },
      }),
    );
    renderApp('/projects/project-1/submissions');
    expect(await screen.findByRole('link', { name: 'Build it' })).toHaveAttribute(
      'href',
      '/projects/project-1/tasks?task=t1',
    );
  });
});

// ---------- Activity ----------

describe('task activity wording', () => {
  const entry = (action: string, data: Record<string, unknown>, actorName: string | null) =>
    ({
      id: 'a1',
      action,
      actorName,
      target: null,
      data,
      createdAt: '2026-09-28T10:00:00.000Z',
    }) as unknown as ActivityEntry;

  it('describes every task action', () => {
    expect(describeActivity(entry('task.created', { title: 'X' }, 'Ada'))).toBe(
      'Ada created the task “X”',
    );
    expect(describeActivity(entry('task.updated', { title: 'X', fields: ['title'] }, 'Ada'))).toBe(
      'Ada edited the task “X”',
    );
    expect(describeActivity(entry('task.deleted', { title: 'X' }, 'Ada'))).toBe(
      'Ada deleted the task “X”',
    );
    expect(
      describeActivity(entry('task.moved', { title: 'X', from: 'todo', to: 'in_progress' }, 'Ada')),
    ).toBe('Ada moved the task “X” from To do to In progress');
    expect(
      describeActivity(
        entry(
          'task.moved',
          { title: 'X', from: 'in_progress', to: 'in_review', automatic: true },
          null,
        ),
      ),
    ).toBe('The task “X” moved from In progress to In review automatically');
    expect(describeActivity(entry('task.done_confirmed', { title: 'X', done: true }, 'Lee'))).toBe(
      'Lee marked the task “X” done',
    );
    expect(describeActivity(entry('task.done_confirmed', { title: 'X', done: false }, 'Lee'))).toBe(
      'Lee said the task “X” isn’t done yet',
    );
  });
});
