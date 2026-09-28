import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CopyResponseSchema,
  MarkNotificationsReadResponseSchema,
  NotificationListResponseSchema,
  type NotificationData,
  type NotificationType,
  type NotificationView,
} from '@devspace/shared';
import { updateProjectCopies } from '../src/copies/update.ts';
import { runHousekeeping } from '../src/housekeeping/index.ts';
import { prisma } from '../src/lib/prisma.ts';
import { deleteOldNotifications, notify } from '../src/notifications/service.ts';
import { closeEmitter } from '../src/realtime/emitter.ts';
import {
  addMember,
  as,
  cleanUp,
  commitFiles,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';
import {
  approve,
  getCopy,
  merge,
  revert,
  setPermissions,
  setSettings,
  submit,
  url,
  world,
  write,
} from './phase7.ts';
import {
  closeSockets,
  connect,
  join,
  record,
  sleep,
  startSocketServer,
  waitFor,
  type SocketServer,
} from './sockets.ts';

vi.setConfig({ testTimeout: 60_000 });

let s: SocketServer;
beforeAll(async () => {
  s = await startSocketServer();
});
afterEach(() => closeSockets());
afterAll(async () => {
  closeSockets();
  await s.close();
  await sleep(200); // let disconnect handlers finish before Redis closes
  await closeEmitter();
  await cleanUp();
});

async function list(user: TestUser, cursor?: string) {
  const res = await as(user).get(
    `/api/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return NotificationListResponseSchema.parse(res.body);
}

/** The user's notifications of one type in this project, newest first. */
async function of(user: TestUser, type: NotificationType, projectId?: string) {
  const { notifications } = await list(user);
  return notifications.filter(
    (n) => n.type === type && (projectId === undefined || n.project?.id === projectId),
  );
}

function dataOf<T extends NotificationType>(n: NotificationView, type: T): NotificationData<T> {
  expect(n.type).toBe(type);
  return n.data as NotificationData<T>;
}

describe('submission notifications', () => {
  it('opened → leads and members with Approve, never the author', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'changed\n');
    const sub = await submit(w, w.ann, ['src/a.ts'], 'Opened work');
    for (const user of [w.leader, w.rev]) {
      const [n] = await of(user, 'submission.opened', w.projectId);
      expect(n, user.name).toBeDefined();
      expect(dataOf(n!, 'submission.opened')).toEqual({
        submissionId: sub.id,
        title: 'Opened work',
        actorName: 'Ann Author',
      });
      expect(n!.project).toEqual({ id: w.projectId, name: 'Merge Project' });
      expect(n!.readAt).toBeNull();
    }
    expect(await of(w.bob, 'submission.opened', w.projectId)).toEqual([]);
    expect(await of(w.ann, 'submission.opened', w.projectId)).toEqual([]);
  });

  it('reviewed, commented (and replies), rejected → the right people, never the actor', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'changed\n');
    const sub = await submit(w, w.ann, ['src/a.ts'], 'Review me');

    const review = await as(w.rev).post(url(w, `/submissions/${sub.id}/reviews`), {
      decision: 'changes_requested',
    });
    expect(review.status).toBe(200);
    const [reviewed] = await of(w.ann, 'submission.reviewed', w.projectId);
    expect(dataOf(reviewed!, 'submission.reviewed')).toMatchObject({
      submissionId: sub.id,
      decision: 'changes_requested',
      actorName: 'Rex Reviewer',
    });
    expect(await of(w.rev, 'submission.reviewed')).toEqual([]);

    const comment = await as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), {
      body: 'Please explain',
    });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const [commented] = await of(w.ann, 'submission.commented', w.projectId);
    expect(dataOf(commented!, 'submission.commented')).toMatchObject({
      commentId: comment.body.comment.id,
      reply: false,
      suggestion: false,
    });
    // The author replies: the reviewer hears of it; the author doesn't get their own.
    const reply = await as(w.ann).post(url(w, `/submissions/${sub.id}/comments`), {
      body: 'Sure',
      parentId: comment.body.comment.id,
    });
    expect(reply.status).toBe(201);
    const [replied] = await of(w.rev, 'submission.commented', w.projectId);
    expect(dataOf(replied!, 'submission.commented')).toMatchObject({
      commentId: reply.body.comment.id,
      reply: true,
      actorName: 'Ann Author',
    });
    expect(await of(w.ann, 'submission.commented', w.projectId)).toHaveLength(1);
    // A line suggestion is a comment too.
    const suggestion = await as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), {
      body: 'Try this',
      path: 'src/a.ts',
      side: 'head',
      line: 1,
      suggestion: 'better\n',
    });
    expect(suggestion.status, JSON.stringify(suggestion.body)).toBe(201);
    const [suggested] = await of(w.ann, 'submission.commented', w.projectId);
    expect(dataOf(suggested!, 'submission.commented').suggestion).toBe(true);

    const reject = await as(w.leader).post(url(w, `/submissions/${sub.id}/reject`), {
      reason: 'Not needed',
    });
    expect(reject.status).toBe(200);
    const [rejected] = await of(w.ann, 'submission.rejected', w.projectId);
    expect(dataOf(rejected!, 'submission.rejected')).toMatchObject({
      reason: 'Not needed',
      actorName: 'Lena Leader',
    });
    expect(await of(w.leader, 'submission.rejected')).toEqual([]);
  });

  it('merged, needs update, reverted → the author', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n',
    );
    write(
      w.bobCopy,
      'src/a.ts',
      'export const a = 200;\nexport const b = 2;\nexport const c = 3;\n',
    );
    const annSub = await submit(w, w.ann, ['src/a.ts'], 'Ann work');
    const bobSub = await submit(w, w.bob, ['src/a.ts'], 'Bob work');
    await approve(w, annSub.id);
    expect((await merge(w, annSub.id)).status).toBe(200);

    const [merged] = await of(w.ann, 'submission.merged', w.projectId);
    expect(dataOf(merged!, 'submission.merged')).toEqual({
      submissionId: annSub.id,
      title: 'Ann work',
      actorName: 'Lena Leader',
    });
    expect(await of(w.leader, 'submission.merged')).toEqual([]);
    const [needs] = await of(w.bob, 'submission.needs_update', w.projectId);
    expect(dataOf(needs!, 'submission.needs_update')).toEqual({
      submissionId: bobSub.id,
      title: 'Bob work',
      paths: ['src/a.ts'],
      morePaths: 0,
    });

    // Undo: bob's no longer conflicts; ann hears of the revert.
    expect((await revert(w, annSub.id)).status).toBe(200);
    const [reverted] = await of(w.ann, 'submission.reverted', w.projectId);
    expect(dataOf(reverted!, 'submission.reverted').submissionId).toBe(annSub.id);
    // Told once, when it became Needs update.
    expect(await of(w.bob, 'submission.needs_update', w.projectId)).toHaveLength(1);
  });

  it('pushes the notification and unread count live, to that user only', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'live\n');
    const sub = await submit(w, w.ann, ['src/a.ts'], 'Live');
    const annSocket = await connect(s, w.ann);
    const bobSocket = await connect(s, w.bob);
    const annGot = record(annSocket, 'notification');
    const bobGot = record(bobSocket, 'notification');
    const before = (await list(w.ann)).unreadCount;
    await approve(w, sub.id);
    const event = await waitFor(annGot, (e) => e.notification.type === 'submission.reviewed');
    expect(event.unreadCount).toBe(before + 1);
    expect(dataOf(event.notification, 'submission.reviewed').submissionId).toBe(sub.id);
    await sleep(300);
    expect(bobGot).toEqual([]);
  });
});

describe('task notifications', () => {
  it('assigned (new assignees only), confirm_done (leads), reopened (assignees)', async () => {
    const w = await world();
    const coLead = await signUp('Cole Colead');
    await addMember(w.leader, w.projectId, coLead);
    const promote = await as(w.leader).patch(`/api/projects/${w.projectId}/members/${coLead.id}`, {
      role: 'co_leader',
    });
    expect(promote.status).toBe(200);
    const [role] = await of(coLead, 'member.role_changed', w.projectId);
    expect(dataOf(role!, 'member.role_changed')).toEqual({
      actorName: 'Lena Leader',
      role: 'co_leader',
    });

    const created = await as(w.leader).post(url(w, '/tasks'), {
      title: 'Build it',
      description: '',
      assigneeIds: [w.ann.id, w.leader.id],
    });
    expect(created.status).toBe(201);
    const taskId = created.body.task.id as string;
    const [assigned] = await of(w.ann, 'task.assigned', w.projectId);
    expect(dataOf(assigned!, 'task.assigned')).toEqual({
      taskId,
      title: 'Build it',
      actorName: 'Lena Leader',
    });
    expect(await of(w.leader, 'task.assigned')).toEqual([]);

    const edited = await as(w.leader).patch(url(w, `/tasks/${taskId}`), {
      assigneeIds: [w.ann.id, w.bob.id],
    });
    expect(edited.status).toBe(200);
    expect(await of(w.bob, 'task.assigned', w.projectId)).toHaveLength(1);
    expect(await of(w.ann, 'task.assigned', w.projectId)).toHaveLength(1);

    write(w.annCopy, 'src/a.ts', 'task work\n');
    const sub = await submit(w, w.ann, ['src/a.ts'], 'Task work');
    const link = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), { taskId });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    await approve(w, sub.id);
    expect((await merge(w, sub.id)).status).toBe(200);
    // Leads are asked to confirm, except the lead who merged.
    const [confirm] = await of(coLead, 'task.confirm_done', w.projectId);
    expect(dataOf(confirm!, 'task.confirm_done')).toEqual({
      taskId,
      title: 'Build it',
      submissionId: sub.id,
    });
    expect(await of(w.leader, 'task.confirm_done')).toEqual([]);
    expect(await of(w.ann, 'task.confirm_done')).toEqual([]);

    expect((await revert(w, sub.id)).status).toBe(200);
    for (const user of [w.ann, w.bob]) {
      const [reopened] = await of(user, 'task.reopened', w.projectId);
      expect(dataOf(reopened!, 'task.reopened')).toMatchObject({
        taskId,
        submissionId: sub.id,
        note: "Merge of 'Task work' was undone",
      });
    }
  });
});

describe('member, invitation and copy notifications', () => {
  it('permissions changed → that member; invitation accepted → leads', async () => {
    const w = await world();
    await setPermissions(w.leader, w.projectId, w.bob, { comment: true });
    const [perm] = await of(w.bob, 'member.permissions_changed', w.projectId);
    expect(dataOf(perm!, 'member.permissions_changed')).toEqual({ actorName: 'Lena Leader' });
    // world() added ann, rex and bob by invitation.
    const accepted = await of(w.leader, 'invitation.accepted', w.projectId);
    expect(accepted.map((n) => dataOf(n, 'invitation.accepted').userName).sort()).toEqual([
      'Ann Author',
      'Bob Builder',
      'Rex Reviewer',
    ]);
    expect(await of(w.ann, 'invitation.accepted')).toEqual([]);
  });

  it('copy.helped → the copy owner', async () => {
    const w = await world();
    await prisma.copy.update({ where: { id: w.annCopyId }, data: { containerStatus: 'running' } });
    const res = await as(w.leader).post(url(w, `/members/${w.ann.id}/copy/ide/launch`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [helped] = await of(w.ann, 'copy.helped', w.projectId);
    expect(dataOf(helped!, 'copy.helped')).toEqual({ actorName: 'Lena Leader' });
  });

  it('copy.update_conflicts once per new set of conflicts (automatic mode)', async () => {
    const w = await world();
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n',
    );
    write(
      w.bobCopy,
      'src/a.ts',
      'export const a = 200;\nexport const b = 2;\nexport const c = 3;\n',
    );
    const sub = await submit(w, w.ann, ['src/a.ts'], 'Ann');
    await approve(w, sub.id);
    expect((await merge(w, sub.id)).status).toBe(200);
    const socket = await connect(s, w.leader);
    await join(socket, w.projectId);
    const events = record(socket, 'invalidate');
    const result = await updateProjectCopies(w.projectId);
    expect(result.pending).toEqual([w.bobCopyId]);
    const [n] = await of(w.bob, 'copy.update_conflicts', w.projectId);
    expect(dataOf(n!, 'copy.update_conflicts')).toEqual({ paths: ['src/a.ts'], morePaths: 0 });
    // What the worker runs sends invalidations through Redis too.
    await waitFor(events, (e) => e.keys.includes(`copy:${w.bob.id}`));
    await updateProjectCopies(w.projectId);
    expect(await of(w.bob, 'copy.update_conflicts', w.projectId)).toHaveLength(1);
  });
});

describe('npm reminder (packages changed)', () => {
  it('flags copies whose update brings a package file change; dismiss clears it', async () => {
    const w = await world({
      'README.md': '# P\n',
      'package.json': '{"name":"p"}\n',
      'web/package-lock.json': '{}\n',
    });
    expect((await getCopy(w, w.bob)).packagesChanged).toBe(false);
    write(w.annCopy, 'package.json', '{"name":"p","dependencies":{"x":"1"}}\n');
    const sub = await submit(w, w.ann, ['package.json'], 'Add x');
    await approve(w, sub.id);
    expect((await merge(w, sub.id)).status).toBe(200);
    const result = await updateProjectCopies(w.projectId);
    expect(result.updated.sort()).toEqual([w.annCopyId, w.bobCopyId].sort());

    const bobCopy = await getCopy(w, w.bob);
    expect(bobCopy.packagesChanged).toBe(true);
    const [n] = await of(w.bob, 'copy.packages_changed', w.projectId);
    expect(dataOf(n!, 'copy.packages_changed')).toEqual({ paths: ['package.json'], morePaths: 0 });

    const dismiss = await as(w.bob).post(url(w, '/copy/packages-dismiss'));
    expect(dismiss.status).toBe(200);
    expect(CopyResponseSchema.parse(dismiss.body).copy!.packagesChanged).toBe(false);
    expect((await getCopy(w, w.bob)).packagesChanged).toBe(false);
    const nobody = await signUp('No Copy');
    await addMember(w.leader, w.projectId, nobody);
    expectError(await as(nobody).post(url(w, '/copy/packages-dismiss')), 409, 'no_copy');
    const stranger = await signUp('Stranger');
    expectError(await as(stranger).post(url(w, '/copy/packages-dismiss')), 404, 'not_found');
  });

  it('a manual update by the owner sets the flag without notifying them; other files don’t', async () => {
    const w = await world({ 'README.md': '# P\n', 'app/package.json': '{}\n' });
    await setSettings(w, { copyUpdateMode: 'manual' });
    // A change that touches no package file first.
    await commitFiles(w.gitDir, { 'README.md': '# Q\n', 'app/package.json': '{}\n' });
    expect((await as(w.bob).post(url(w, '/copy/update'))).status).toBe(200);
    expect((await getCopy(w, w.bob)).packagesChanged).toBe(false);
    await commitFiles(w.gitDir, { 'README.md': '# Q\n', 'app/package.json': '{"v":2}\n' });
    expect((await as(w.bob).post(url(w, '/copy/update'))).status).toBe(200);
    expect((await getCopy(w, w.bob)).packagesChanged).toBe(true);
    expect(await of(w.bob, 'copy.packages_changed')).toEqual([]);
  });
});

describe('listing, reading, cleanup', () => {
  it('lists own notifications newest first, 30 a page, with a cursor', async () => {
    const user = await signUp('Pager');
    const other = await signUp('Other');
    for (let i = 0; i < 35; i++) {
      await notify(prisma, {
        type: 'copy.helped',
        projectId: null,
        userIds: [user.id],
        actorId: null,
        data: { actorName: `Helper ${i}` },
      });
    }
    await notify(prisma, {
      type: 'copy.helped',
      projectId: null,
      userIds: [other.id],
      actorId: null,
      data: { actorName: 'Not yours' },
    });
    const first = await list(user);
    expect(first.notifications).toHaveLength(30);
    expect(first.unreadCount).toBe(35);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(user, first.nextCursor!);
    expect(second.notifications).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.notifications, ...second.notifications];
    expect(new Set(all.map((n) => n.id)).size).toBe(35);
    const names = all.map((n) => dataOf(n, 'copy.helped').actorName);
    expect(names[0]).toBe('Helper 34');
    expect(names.at(-1)).toBe('Helper 0');
    expect(names).not.toContain('Not yours');
    expectError(await as(user).get('/api/notifications?cursor=%%%'), 400, 'validation_error');

    // Mark some read (others' ids are ignored), then all.
    const theirs = (await list(other)).notifications[0]!.id;
    const read = await as(user).post('/api/notifications/read', {
      ids: [all[0]!.id, all[1]!.id, theirs],
    });
    expect(read.status).toBe(200);
    expect(MarkNotificationsReadResponseSchema.parse(read.body).unreadCount).toBe(33);
    expect((await list(other)).unreadCount).toBe(1);
    expect((await list(user)).notifications[0]!.readAt).not.toBeNull();
    expectError(await as(user).post('/api/notifications/read', {}), 400, 'validation_error');
    expectError(
      await as(user).post('/api/notifications/read', { all: true, ids: ['x'] }),
      400,
      'validation_error',
    );
    const allRead = await as(user).post('/api/notifications/read', { all: true });
    expect(allRead.body).toEqual({ unreadCount: 0 });
  });

  it('never notifies the actor, and needs login', async () => {
    const user = await signUp('Self');
    const count = await notify(prisma, {
      type: 'copy.helped',
      projectId: null,
      userIds: [user.id],
      actorId: user.id,
      data: { actorName: 'Self' },
    });
    expect(count).toBe(0);
    const { app } = await import('./helpers.ts');
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });

  it('deletes notifications older than 30 days (housekeeping)', async () => {
    const user = await signUp('Old News');
    await notify(prisma, {
      type: 'copy.helped',
      projectId: null,
      userIds: [user.id],
      actorId: null,
      data: { actorName: 'x' },
    });
    const [row] = await prisma.notification.findMany({ where: { userId: user.id } });
    await prisma.notification.update({
      where: { id: row!.id },
      data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    await notify(prisma, {
      type: 'copy.helped',
      projectId: null,
      userIds: [user.id],
      actorId: null,
      data: { actorName: 'recent' },
    });
    expect(await deleteOldNotifications()).toBeGreaterThanOrEqual(1);
    const left = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(left).toHaveLength(1);
    expect((left[0]!.data as { actorName: string }).actorName).toBe('recent');
    const run = await runHousekeeping({ copyIds: [] });
    expect(run.notificationsDeleted).toBe(0);
  });

  it('removing a member deletes their notifications for that project', async () => {
    const w = await world();
    expect((await of(w.rev, 'member.permissions_changed', w.projectId)).length).toBe(1);
    const res = await as(w.leader).delete(`/api/projects/${w.projectId}/members/${w.rev.id}`);
    expect(res.status).toBe(204);
    expect(
      await prisma.notification.count({ where: { userId: w.rev.id, projectId: w.projectId } }),
    ).toBe(0);
  });
});
