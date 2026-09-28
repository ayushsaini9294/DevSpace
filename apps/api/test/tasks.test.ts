import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ActivityListResponseSchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  TaskListResponseSchema,
  TaskResponseSchema,
  type SubmissionDetail,
  type TaskView,
} from '@devspace/shared';
import { prisma } from '../src/lib/prisma.ts';
import {
  addMember,
  as,
  cleanUp,
  createProject,
  createTeam,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';
import {
  approve,
  detail,
  merge,
  revert,
  setPermissions,
  showFile,
  url,
  world,
  write,
  type World,
} from './phase7.ts';

afterAll(cleanUp);
vi.setConfig({ testTimeout: 60_000 });

// ---------- Helpers ----------

async function newTask(
  w: World,
  user: TestUser,
  body: Record<string, unknown> = {},
): Promise<TaskView> {
  const res = await as(user).post(url(w, '/tasks'), {
    title: 'Build the login page',
    assigneeIds: [w.ann.id],
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return TaskResponseSchema.parse(res.body).task;
}

async function getTask(w: World, id: string, user: TestUser = w.leader): Promise<TaskView> {
  const res = await as(user).get(url(w, `/tasks/${id}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return TaskResponseSchema.parse(res.body).task;
}

function move(w: World, id: string, user: TestUser, status: string, position = 1) {
  return as(user).post(url(w, `/tasks/${id}/move`), { status, position });
}

function confirm(w: World, id: string, user: TestUser, done: boolean) {
  return as(user).post(url(w, `/tasks/${id}/confirm-done`), { done });
}

let fileCounter = 0;

/** `user` changes a fresh file in their copy and submits it, linked to `taskId`. */
async function submitLinked(
  w: World,
  user: TestUser,
  taskId: string | null | undefined,
  title = 'Login work',
): Promise<SubmissionDetail> {
  const path = `src/work-${++fileCounter}.ts`;
  write(user === w.bob ? w.bobCopy : w.annCopy, path, `export const n = ${fileCounter};\n`);
  const res = await as(user).post(url(w, '/submissions'), {
    title,
    paths: [path],
    ...(taskId === undefined ? {} : { taskId }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SubmissionResponseSchema.parse(res.body).submission;
}

async function mergeApproved(w: World, id: string) {
  await approve(w, id);
  const res = await merge(w, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SubmissionResponseSchema.parse(res.body).submission;
}

async function taskActivity(w: World, taskId: string) {
  const res = await as(w.leader).get(url(w, '/activity'));
  return ActivityListResponseSchema.parse(res.body).entries.filter((e) => e.target === taskId);
}

// ---------- Create, read, edit, delete ----------

describe('creating and reading tasks', () => {
  it('lets leads and members with Create tasks create; others get 403', async () => {
    const w = await world();
    expectError(
      await as(w.ann).post(url(w, '/tasks'), { title: 'x', assigneeIds: [w.ann.id] }),
      403,
      'forbidden',
    );

    const task = await newTask(w, w.leader, {
      description: 'Email and password',
      assigneeIds: [w.ann.id, w.bob.id],
      dueDate: '2026-10-15',
    });
    expect(task).toMatchObject({
      title: 'Build the login page',
      description: 'Email and password',
      status: 'todo',
      dueDate: '2026-10-15',
      createdBy: { id: w.leader.id, name: w.leader.name },
      doneConfirmPending: false,
      reopenNote: null,
      linkedSubmissions: [],
      completedAt: null,
    });
    // Sorted by name: Ann before Bob.
    expect(task.assignees.map((a) => a.id)).toEqual([w.ann.id, w.bob.id]);
    expect(task.viewerActions).toEqual(['edit', 'move', 'delete']);
    expect((await getTask(w, task.id, w.ann)).viewerActions).toEqual(['move']);
    expect((await getTask(w, task.id, w.rev)).viewerActions).toEqual([]);

    await setPermissions(w.leader, w.projectId, w.rev, { createTasks: true });
    const second = await newTask(w, w.rev, { title: 'Second' });
    expect(second.position).toBeGreaterThan(task.position);

    const list = await as(w.bob).get(url(w, '/tasks'));
    expect(list.status).toBe(200);
    expect(TaskListResponseSchema.parse(list.body).tasks.map((t) => t.id)).toEqual([
      task.id,
      second.id,
    ]);

    const entries = await taskActivity(w, task.id);
    expect(entries.find((e) => e.action === 'task.created')).toMatchObject({
      actorId: w.leader.id,
      data: { title: 'Build the login page' },
    });
  });

  it('refuses assignees who are not members, and bad bodies', async () => {
    const w = await world();
    const outsider = await signUp('Olly Outsider');
    for (const assigneeIds of [
      [outsider.id],
      [w.ann.id, 'no-such-user'],
      [],
      [w.ann.id, w.ann.id],
    ]) {
      const res = await as(w.leader).post(url(w, '/tasks'), { title: 'x', assigneeIds });
      expectError(res, 400, 'validation_error');
      expect(res.body.fields.assigneeIds).toBeDefined();
    }
    expectError(
      await as(w.leader).post(url(w, '/tasks'), {
        title: 'x',
        assigneeIds: [w.ann.id],
        dueDate: '15/10/2026',
      }),
      400,
      'validation_error',
    );
    // Not a member of the project at all: 404.
    expectError(await as(outsider).get(url(w, '/tasks')), 404, 'not_found');
    expectError(
      await as(outsider).post(url(w, '/tasks'), { title: 'x', assigneeIds: [outsider.id] }),
      404,
      'not_found',
    );
  });

  it('lets leads edit any task and creators edit their own while they have Create tasks', async () => {
    const w = await world();
    await setPermissions(w.leader, w.projectId, w.bob, { createTasks: true });
    const leaderTask = await newTask(w, w.leader);
    const bobTask = await newTask(w, w.bob, { title: 'Bob’s task', dueDate: '2026-11-01' });
    expect(bobTask.viewerActions).toEqual(['edit']);

    const edited = await as(w.bob).patch(url(w, `/tasks/${bobTask.id}`), {
      title: 'Renamed',
      dueDate: null,
      assigneeIds: [w.bob.id, w.rev.id],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const view = TaskResponseSchema.parse(edited.body).task;
    expect(view.title).toBe('Renamed');
    expect(view.dueDate).toBeNull();
    expect(view.assignees.map((a) => a.id).sort()).toEqual([w.bob.id, w.rev.id].sort());
    const updated = (await taskActivity(w, bobTask.id)).find((e) => e.action === 'task.updated');
    expect(updated?.data).toMatchObject({ title: 'Renamed' });
    expect((updated?.data.fields as string[]).sort()).toEqual(
      ['assigneeIds', 'dueDate', 'title'].sort(),
    );

    // Not their task; an assignee can't edit either.
    expectError(
      await as(w.bob).patch(url(w, `/tasks/${leaderTask.id}`), { title: 'Mine now' }),
      403,
      'forbidden',
    );
    expectError(
      await as(w.ann).patch(url(w, `/tasks/${leaderTask.id}`), { title: 'Mine now' }),
      403,
      'forbidden',
    );
    // Leads edit anything, including assignees (who must be members).
    const lead = await as(w.leader).patch(url(w, `/tasks/${bobTask.id}`), { description: 'More' });
    expect(lead.status).toBe(200);
    expectError(
      await as(w.leader).patch(url(w, `/tasks/${bobTask.id}`), { assigneeIds: ['nobody'] }),
      400,
      'validation_error',
    );
    expectError(
      await as(w.leader).patch(url(w, `/tasks/${bobTask.id}`), {}),
      400,
      'validation_error',
    );

    // Once Create tasks is switched off, the creator can't edit their task any more.
    await setPermissions(w.leader, w.projectId, w.bob, { createTasks: false });
    expectError(
      await as(w.bob).patch(url(w, `/tasks/${bobTask.id}`), { title: 'Again' }),
      403,
      'forbidden',
    );
    expect((await getTask(w, bobTask.id, w.bob)).viewerActions).not.toContain('edit');
  });

  it('lets only leads delete; linked submissions stay and lose the link', async () => {
    const w = await world();
    await setPermissions(w.leader, w.projectId, w.ann, { createTasks: true });
    const task = await newTask(w, w.ann);
    const sub = await submitLinked(w, w.ann, task.id);
    expect(sub.task?.id).toBe(task.id);

    expectError(await as(w.ann).delete(url(w, `/tasks/${task.id}`), {}), 403, 'forbidden');
    expect((await as(w.leader).delete(url(w, `/tasks/${task.id}`), {})).status).toBe(204);
    expectError(await as(w.leader).get(url(w, `/tasks/${task.id}`)), 404, 'not_found');
    expectError(await as(w.leader).delete(url(w, `/tasks/${task.id}`), {}), 404, 'not_found');

    expect((await detail(w, sub.id, w.ann)).task).toBeNull();
    const deleted = await prisma.activityLog.findFirst({
      where: { projectId: w.projectId, action: 'task.deleted', target: task.id },
    });
    expect(deleted?.data).toMatchObject({ title: 'Build the login page' });
  });

  it('hides tasks of other projects (404)', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const team = await createTeam(w.leader, 'Other team');
    const other = await createProject(w.leader, team.id, 'Other');
    expectError(
      await as(w.leader).get(`/api/projects/${other.id}/tasks/${task.id}`),
      404,
      'not_found',
    );
    expectError(
      await as(w.leader).post(`/api/projects/${other.id}/tasks/${task.id}/move`, {
        status: 'done',
        position: 1,
      }),
      404,
      'not_found',
    );
  });
});

// ---------- Moving by hand ----------

describe('moving tasks by hand', () => {
  it('lets assignees move only between To do and In progress', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);

    const res = await move(w, task.id, w.ann, 'in_progress', 5);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(TaskResponseSchema.parse(res.body).task).toMatchObject({
      status: 'in_progress',
      position: 5,
    });
    // Reordering inside the column is fine, and so is going back.
    expect((await move(w, task.id, w.ann, 'in_progress', 2.5)).status).toBe(200);
    expect((await move(w, task.id, w.ann, 'todo', 1)).status).toBe(200);
    expect((await move(w, task.id, w.ann, 'in_progress', 1)).status).toBe(200);

    expectError(await move(w, task.id, w.ann, 'in_review'), 409, 'invalid_move');
    expectError(await move(w, task.id, w.ann, 'done'), 409, 'invalid_move');
    // Not an assignee and not a lead.
    expectError(await move(w, task.id, w.bob, 'todo'), 403, 'forbidden');
    expectError(await move(w, task.id, w.rev, 'in_progress'), 403, 'forbidden');
    expectError(
      await as(w.ann).post(url(w, `/tasks/${task.id}/move`), { status: 'blocked', position: 1 }),
      400,
      'validation_error',
    );

    const moves = (await taskActivity(w, task.id)).filter((e) => e.action === 'task.moved');
    // Three column changes (the reorder isn't logged), newest first.
    expect(moves).toHaveLength(3);
    expect(moves[0]).toMatchObject({
      actorId: w.ann.id,
      data: { title: task.title, from: 'todo', to: 'in_progress', automatic: false },
    });
  });

  it('lets leads move anything anywhere, including reopening Done', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const done = await move(w, task.id, w.leader, 'done', 3);
    expect(done.status).toBe(200);
    const view = TaskResponseSchema.parse(done.body).task;
    expect(view.status).toBe('done');
    expect(view.completedAt).not.toBeNull();

    // The assignee can't touch a Done task.
    expect((await getTask(w, task.id, w.ann)).viewerActions).not.toContain('move');
    expectError(await move(w, task.id, w.ann, 'in_progress'), 409, 'invalid_move');

    expect((await move(w, task.id, w.leader, 'in_review')).status).toBe(200);
    const reopened = await move(w, task.id, w.leader, 'todo');
    expect(TaskResponseSchema.parse(reopened.body).task).toMatchObject({
      status: 'todo',
      completedAt: null,
    });
  });
});

// ---------- Automatic rules ----------

describe('linking submissions to tasks', () => {
  it('moves the task to In review when linked work is submitted, from any column but Done', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    expect((await move(w, task.id, w.ann, 'in_progress')).status).toBe(200);

    const sub = await submitLinked(w, w.ann, task.id, 'Login form');
    expect(sub.task).toEqual({ id: task.id, title: task.title, status: 'in_review' });
    const view = await getTask(w, task.id);
    expect(view.status).toBe('in_review');
    expect(view.linkedSubmissions).toEqual([{ id: sub.id, title: 'Login form', status: 'open' }]);

    const list = await as(w.bob).get(url(w, '/submissions'));
    expect(SubmissionListResponseSchema.parse(list.body).submissions[0]?.task?.id).toBe(task.id);

    const automatic = (await taskActivity(w, task.id)).find(
      (e) => e.action === 'task.moved' && e.data.automatic === true,
    );
    expect(automatic).toMatchObject({
      actorId: null,
      data: { from: 'in_progress', to: 'in_review', automatic: true },
    });

    // Straight from To do works too.
    const fresh = await newTask(w, w.leader, { title: 'Fresh' });
    await submitLinked(w, w.ann, fresh.id);
    expect((await getTask(w, fresh.id)).status).toBe('in_review');
  });

  it('refuses Done tasks (task_done) and unknown or foreign tasks (400 on taskId)', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    expect((await move(w, task.id, w.leader, 'done')).status).toBe(200);
    write(w.annCopy, 'src/refused.ts', 'x\n');
    const body = { title: 'T', paths: ['src/refused.ts'] };
    expectError(
      await as(w.ann).post(url(w, '/submissions'), { ...body, taskId: task.id }),
      409,
      'task_done',
    );
    const unknown = await as(w.ann).post(url(w, '/submissions'), { ...body, taskId: 'nope' });
    expectError(unknown, 400, 'validation_error');
    expect(unknown.body.fields.taskId).toBeDefined();

    const other = await world();
    const foreign = await newTask(other, other.leader, { assigneeIds: [other.ann.id] });
    expectError(
      await as(w.ann).post(url(w, '/submissions'), { ...body, taskId: foreign.id }),
      400,
      'validation_error',
    );
    // Nothing was created by the refused requests.
    expect(await prisma.submission.count({ where: { projectId: w.projectId } })).toBe(0);
  });

  it('links, keeps and unlinks tasks on update', async () => {
    const w = await world();
    const first = await newTask(w, w.leader, { title: 'First' });
    const second = await newTask(w, w.leader, { title: 'Second' });
    const sub = await submitLinked(w, w.ann, undefined);
    expect(sub.task).toBeNull();
    expect((await getTask(w, first.id)).status).toBe('todo');

    const link = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), {
      taskId: first.id,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(SubmissionResponseSchema.parse(link.body).submission.task?.id).toBe(first.id);
    expect((await getTask(w, first.id)).status).toBe('in_review');

    // A missing taskId keeps the link.
    const keep = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), { title: 'Again' });
    expect(SubmissionResponseSchema.parse(keep.body).submission.task?.id).toBe(first.id);

    // Moving the link: the old task goes back to In progress, the new one to In review.
    const swap = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), {
      taskId: second.id,
    });
    expect(swap.status).toBe(200);
    expect((await getTask(w, first.id)).status).toBe('in_progress');
    expect((await getTask(w, second.id)).status).toBe('in_review');

    const unlink = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), { taskId: null });
    expect(SubmissionResponseSchema.parse(unlink.body).submission.task).toBeNull();
    expect((await getTask(w, second.id)).status).toBe('in_progress');

    expect((await move(w, first.id, w.leader, 'done')).status).toBe(200);
    expectError(
      await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), { taskId: first.id }),
      409,
      'task_done',
    );
  });

  it('returns the task to In progress on reject or close when no other linked work is active', async () => {
    const w = await world();
    const task = await newTask(w, w.leader, { assigneeIds: [w.ann.id, w.bob.id] });
    const annSub = await submitLinked(w, w.ann, task.id);
    const bobSub = await submitLinked(w, w.bob, task.id);

    const rejected = await as(w.leader).post(url(w, `/submissions/${annSub.id}/reject`), {
      reason: 'Not this way',
    });
    expect(rejected.status).toBe(200);
    // Bob's submission is still active.
    expect((await getTask(w, task.id)).status).toBe('in_review');

    const closed = await as(w.bob).post(url(w, `/submissions/${bobSub.id}/close`));
    expect(closed.status).toBe(200);
    const view = await getTask(w, task.id);
    expect(view.status).toBe('in_progress');
    expect(view.linkedSubmissions.map((s) => s.status).sort()).toEqual(['closed', 'rejected']);
  });
});

describe('merging linked work and confirming Done', () => {
  it('asks leads "Mark this task done?" after a merge; Yes makes it Done', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const sub = await submitLinked(w, w.ann, task.id);
    const merged = await mergeApproved(w, sub.id);
    expect(await showFile(w.gitDir, sub.files[0]!.path)).toContain('export const n');

    expect(merged.viewerActions).toContain('confirmTaskDone');
    expect(merged.task?.status).toBe('in_review');
    const leadView = await getTask(w, task.id);
    expect(leadView).toMatchObject({ status: 'in_review', doneConfirmPending: true });
    expect(leadView.viewerActions).toContain('confirmDone');

    // The member sees no prompt and can't answer it.
    const annView = await getTask(w, task.id, w.ann);
    expect(annView.viewerActions).not.toContain('confirmDone');
    expect((await detail(w, sub.id, w.ann)).viewerActions).not.toContain('confirmTaskDone');
    expectError(await confirm(w, task.id, w.ann, true), 403, 'forbidden');

    const yes = await confirm(w, task.id, w.leader, true);
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    const done = TaskResponseSchema.parse(yes.body).task;
    expect(done).toMatchObject({ status: 'done', doneConfirmPending: false });
    expect(done.completedAt).not.toBeNull();
    expect(done.viewerActions).not.toContain('confirmDone');
    expect((await detail(w, sub.id, w.leader)).viewerActions).not.toContain('confirmTaskDone');

    expectError(await confirm(w, task.id, w.leader, true), 409, 'not_pending');
    const confirmed = (await taskActivity(w, task.id)).find(
      (e) => e.action === 'task.done_confirmed',
    );
    expect(confirmed).toMatchObject({ actorId: w.leader.id, data: { done: true, to: 'done' } });
  });

  it('answers "Not yet": In progress, or In review while linked work is still active', async () => {
    const w = await world();
    const task = await newTask(w, w.leader, { assigneeIds: [w.ann.id, w.bob.id] });
    const first = await submitLinked(w, w.ann, task.id);
    const second = await submitLinked(w, w.bob, task.id);
    await mergeApproved(w, first.id);

    const notYet = await confirm(w, task.id, w.leader, false);
    expect(notYet.status).toBe(200);
    expect(TaskResponseSchema.parse(notYet.body).task).toMatchObject({
      status: 'in_review',
      doneConfirmPending: false,
    });

    // Bob's work merges too, and this time nothing else is active.
    await mergeApproved(w, second.id);
    const again = await confirm(w, task.id, w.leader, false);
    expect(TaskResponseSchema.parse(again.body).task).toMatchObject({
      status: 'in_progress',
      doneConfirmPending: false,
      completedAt: null,
    });
    expectError(await confirm(w, task.id, w.leader, false), 409, 'not_pending');
  });

  it('keeps the task In review when other linked work ends while a merge waits', async () => {
    const w = await world();
    const task = await newTask(w, w.leader, { assigneeIds: [w.ann.id, w.bob.id] });
    const first = await submitLinked(w, w.ann, task.id);
    const second = await submitLinked(w, w.bob, task.id);
    await mergeApproved(w, first.id);
    const res = await as(w.leader).post(url(w, `/submissions/${second.id}/reject`), {
      reason: 'Not needed',
    });
    expect(res.status).toBe(200);
    expect(await getTask(w, task.id)).toMatchObject({
      status: 'in_review',
      doneConfirmPending: true,
    });
  });

  it('reopens a Done task with a note when its merge is undone; a manual move clears the note', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const sub = await submitLinked(w, w.ann, task.id, 'Login form');
    await mergeApproved(w, sub.id);
    expect((await confirm(w, task.id, w.leader, true)).status).toBe(200);

    const undone = await revert(w, sub.id);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const view = await getTask(w, task.id);
    expect(view).toMatchObject({
      status: 'in_progress',
      doneConfirmPending: false,
      completedAt: null,
      reopenNote: "Merge of 'Login form' was undone",
    });
    const auto = (await taskActivity(w, task.id)).find(
      (e) => e.action === 'task.moved' && e.data.to === 'in_progress',
    );
    expect(auto).toMatchObject({ actorId: null, data: { from: 'done', automatic: true } });

    const moved = await move(w, task.id, w.ann, 'todo');
    expect(TaskResponseSchema.parse(moved.body).task.reopenNote).toBeNull();
  });

  it('reopens a task still waiting for confirmation when its merge is undone', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const sub = await submitLinked(w, w.ann, task.id, 'Waiting work');
    await mergeApproved(w, sub.id);
    expect((await revert(w, sub.id)).status).toBe(200);
    expect(await getTask(w, task.id)).toMatchObject({
      status: 'in_progress',
      doneConfirmPending: false,
      reopenNote: "Merge of 'Waiting work' was undone",
    });
    expectError(await confirm(w, task.id, w.leader, true), 409, 'not_pending');
    // The next confirmation also clears a note: a lead moves it and the note is gone.
    expect((await move(w, task.id, w.leader, 'done')).status).toBe(200);
    expect((await getTask(w, task.id)).reopenNote).toBeNull();
  });

  it('leaves a task alone when an unrelated or not-done task’s merge is undone', async () => {
    const w = await world();
    const task = await newTask(w, w.leader);
    const sub = await submitLinked(w, w.ann, task.id);
    await mergeApproved(w, sub.id);
    // "Not yet" → In progress; then the lead parks it in To do by hand.
    expect((await confirm(w, task.id, w.leader, false)).status).toBe(200);
    expect((await move(w, task.id, w.leader, 'todo')).status).toBe(200);
    expect((await revert(w, sub.id)).status).toBe(200);
    expect(await getTask(w, task.id)).toMatchObject({ status: 'todo', reopenNote: null });
  });
});

// ---------- Members ----------

describe('removing a member', () => {
  it('removes their assignments', async () => {
    const w = await world();
    const task = await newTask(w, w.leader, { assigneeIds: [w.ann.id, w.bob.id] });
    expect((await as(w.leader).delete(url(w, `/members/${w.bob.id}`))).status).toBe(204);
    const view = await getTask(w, task.id);
    expect(view.assignees.map((a) => a.id)).toEqual([w.ann.id]);
    expect(await prisma.taskAssignee.count({ where: { userId: w.bob.id } })).toBe(0);

    // A leaving member loses theirs too, and ex-members can't be assigned.
    expect((await as(w.ann).delete(url(w, `/members/${w.ann.id}`))).status).toBe(204);
    expect((await getTask(w, task.id)).assignees).toEqual([]);
    expectError(
      await as(w.leader).patch(url(w, `/tasks/${task.id}`), { assigneeIds: [w.ann.id] }),
      400,
      'validation_error',
    );
    // Rejoining doesn't bring old assignments back.
    await addMember(w.leader, w.projectId, w.ann);
    expect((await getTask(w, task.id)).assignees).toEqual([]);
  });
});
