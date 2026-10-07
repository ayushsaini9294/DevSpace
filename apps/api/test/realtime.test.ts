import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CopyResponseSchema,
  PresenceListResponseSchema,
  InvalidateKeySchema,
  PreferencesSchema,
  sanitizePresenceFile,
  type PresenceView,
} from '@devspace/shared';
import { invalidationsFor, type ActivityAction } from '../src/activity/log.ts';
import { transaction } from '../src/lib/transaction.ts';
import { createLaunchUrl } from '../src/ide/access.ts';
import { createIdeServer } from '../src/ide/proxy.ts';
import { ideOriginFor } from '../src/ide/origin.ts';
import { ideRequest } from './ide-host.ts';
import { prisma } from '../src/lib/prisma.ts';
import { closeEmitter, invalidateAfterCommit, realtimeKey } from '../src/realtime/emitter.ts';
import { getRedis } from '../src/realtime/redis.ts';
import { sweepPresence } from '../src/realtime/presence.ts';
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
let ideServer: Server;

beforeAll(async () => {
  s = await startSocketServer();
  ideServer = createIdeServer();
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));
});

afterEach(() => closeSockets());

afterAll(async () => {
  closeSockets();
  await s.close();
  await sleep(200); // let disconnect handlers finish before Redis closes
  ideServer.closeAllConnections();
  await new Promise((resolve) => ideServer.close(resolve));
  await closeEmitter();
  await cleanUp();
});

async function team3() {
  const leader = await signUp('Lia Lead');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, 'Live Project');
  const setup = await as(leader).post(`/api/projects/${project.id}/repository`, {
    source: 'empty',
  });
  expect(setup.status).toBe(202);
  const mia = await signUp('Mia Member');
  const noa = await signUp('Noa Member');
  await addMember(leader, project.id, mia);
  await addMember(leader, project.id, noa);
  return { leader, mia, noa, projectId: project.id };
}

async function presence(user: TestUser, projectId: string): Promise<PresenceView[]> {
  const res = await as(user).get(`/api/projects/${projectId}/presence`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PresenceListResponseSchema.parse(res.body).members;
}

async function presenceOf(viewer: TestUser, projectId: string, user: TestUser) {
  const found = (await presence(viewer, projectId)).find((m) => m.user.id === user.id);
  expect(found).toBeDefined();
  return found!;
}

// ---------- Handshake and rooms ----------

describe('socket handshake', () => {
  it('needs the session cookie and the app origin', async () => {
    const { leader } = await team3();
    await expect(connect(s, null)).rejects.toThrow('unauthenticated');
    await expect(connect(s, null, { cookie: 'devspace_session=nope' })).rejects.toThrow(
      'unauthenticated',
    );
    await expect(connect(s, leader, { origin: ideOriginFor(crypto.randomUUID()) })).rejects.toThrow(
      'forbidden_origin',
    );
    await expect(connect(s, leader, { origin: null })).rejects.toThrow('forbidden_origin');
    await expect(connect(s, leader, { origin: 'https://evil.example' })).rejects.toThrow(
      'forbidden_origin',
    );
    const socket = await connect(s, leader);
    expect(socket.connected).toBe(true);
  });

  it('logging out disconnects the session’s sockets', async () => {
    const user = await signUp('Out Going');
    const socket = await connect(s, user);
    const gone = new Promise<string>((resolve) => socket.on('disconnect', resolve));
    const res = await as(user).post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(await gone).toBe('io server disconnect');
  });
});

describe('project rooms', () => {
  it('joins members only', async () => {
    const { leader, projectId } = await team3();
    const stranger = await signUp('Stran Ger');
    const socket = await connect(s, stranger);
    expect(await join(socket, projectId)).toEqual({ ok: false, error: 'not_found' });
    expect(await join(socket, 42)).toEqual({ ok: false, error: 'validation_error' });
    const events = record(socket, 'invalidate');
    const own = await connect(s, leader);
    expect(await join(own, projectId)).toEqual({ ok: true });
    const leaderEvents = record(own, 'invalidate');
    const res = await as(leader).post(`/api/projects/${projectId}/tasks`, {
      title: 'Live task',
      description: '',
      assigneeIds: [leader.id],
    });
    expect(res.status).toBe(201);
    const event = await waitFor(leaderEvents, (e) => e.keys.includes('tasks'));
    expect(event.projectId).toBe(projectId);
    expect(event.keys).toEqual(expect.arrayContaining(['tasks', 'activity']));
    await sleep(300);
    expect(events).toEqual([]);
  });

  it('events carry only what changed, never data', async () => {
    const { leader, mia, projectId } = await team3();
    const socket = await connect(s, mia);
    await join(socket, projectId);
    const events = record(socket, 'invalidate');
    await as(leader).patch(`/api/projects/${projectId}`, { name: 'Renamed Secretly' });
    const event = await waitFor(events, (e) => e.keys.includes('members'));
    expect(Object.keys(event).sort()).toEqual(['keys', 'projectId']);
    expect(JSON.stringify(event)).not.toContain('Renamed');
  });

  it('a removed member leaves the room at once', async () => {
    const { leader, mia, projectId } = await team3();
    const lead = await connect(s, leader);
    await join(lead, projectId);
    const socket = await connect(s, mia);
    await join(socket, projectId);
    const removed = record(socket, 'project:removed');
    const events = record(socket, 'invalidate');
    const leaderEvents = record(lead, 'invalidate');

    const res = await as(leader).delete(`/api/projects/${projectId}/members/${mia.id}`);
    expect(res.status).toBe(204);
    await waitFor(removed, (e) => e.projectId === projectId);
    await waitFor(leaderEvents, (e) => e.keys.includes('members'));
    events.length = 0;
    leaderEvents.length = 0;

    await as(leader).patch(`/api/projects/${projectId}`, { name: 'After removal' });
    await waitFor(leaderEvents, (e) => e.keys.includes('members'));
    await sleep(300);
    expect(events).toEqual([]);
    // And can't join again.
    expect(await join(socket, projectId)).toEqual({ ok: false, error: 'not_found' });
  });

  it('deleting a project empties its room', async () => {
    const { leader, mia, projectId } = await team3();
    const socket = await connect(s, mia);
    await join(socket, projectId);
    const removed = record(socket, 'project:removed');
    const res = await as(leader).delete(`/api/projects/${projectId}`, {
      confirmName: 'Live Project',
    });
    expect(res.status).toBe(204);
    await waitFor(removed, (e) => e.projectId === projectId);
  });
});

// ---------- Presence ----------

/** An IDE session for `user` in `copyId` (like opening the IDE), via the real launch flow. */
async function ideCookie(user: TestUser, copyId: string): Promise<string> {
  const url = new URL(await createLaunchUrl(user.id, copyId));
  const res = await ideRequest(ideServer).get(url.href);
  expect(res.status).toBe(303);
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw.find((c) => c.startsWith('devspace_ide='))!.split(';')[0]!;
}

async function makeCopy(user: TestUser, projectId: string): Promise<string> {
  const res = await as(user).post(`/api/projects/${projectId}/copy`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CopyResponseSchema.parse(res.body).copy!.id;
}

function report(
  copyId: string,
  cookie: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  let req = ideRequest(ideServer)
    .post(`/ide/${copyId}/__devspace/presence`)
    .set('Origin', ideOriginFor(copyId))
    .set('Content-Type', 'application/json');
  if (cookie) req = req.set('Cookie', cookie);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
}

describe('presence', () => {
  it('is offline, then online with an app socket, then offline with last seen', async () => {
    const { leader, mia, projectId } = await team3();
    expect((await presenceOf(leader, projectId, mia)).state).toBe('offline');
    expect((await presenceOf(leader, projectId, mia)).lastSeenAt).toBeNull();

    const lead = await connect(s, leader);
    await join(lead, projectId);
    const events = record(lead, 'presence');
    const socket = await connect(s, mia);
    await join(socket, projectId);
    const online = await waitFor(events, (e) => e.member.user.id === mia.id);
    expect(online.member.state).toBe('online');
    expect((await presenceOf(leader, projectId, mia)).state).toBe('online');

    socket.close();
    const offline = await waitFor(
      events,
      (e) => e.member.user.id === mia.id && e.member.state === 'offline',
    );
    expect(offline.member.lastSeenAt).not.toBeNull();
    const row = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: mia.id } },
    });
    expect(row.lastSeenAt).not.toBeNull();
  });

  it('is 404 for non-members', async () => {
    const { projectId } = await team3();
    const stranger = await signUp('No Body');
    expectError(await as(stranger).get(`/api/projects/${projectId}/presence`), 404, 'not_found');
  });

  it('shows "editing <file>" from the tracker report, live', async () => {
    const { leader, mia, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    const cookie = await ideCookie(mia, copyId);
    const lead = await connect(s, leader);
    await join(lead, projectId);
    const events = record(lead, 'presence');

    const res = await report(copyId, cookie, { file: 'src/app.ts', active: true });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const live = await waitFor(events, (e) => e.member.user.id === mia.id);
    expect(live.member).toMatchObject({ state: 'active', file: 'src/app.ts', copyOwner: null });
    expect(await presenceOf(leader, projectId, mia)).toMatchObject({
      state: 'active',
      file: 'src/app.ts',
    });
    // The endpoint never reaches the container (the copy isn't even running).
    const copy = await prisma.copy.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy.containerStatus).toBe('none');
  });

  it('treats reports as untrusted: always 204, bad ones ignored, unsafe files stored as null', async () => {
    const { leader, mia, noa, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    const cookie = await ideCookie(mia, copyId);
    const fresh = async () => ideCookie(mia, copyId);
    const noSession = await report(copyId, null, { file: 'a.ts', active: true });
    expect([noSession.status, noSession.text]).toEqual([204, '']);
    const wrongOrigin = await report(
      copyId,
      cookie,
      { file: 'a.ts', active: true },
      {
        Origin: 'http://localhost:5173',
      },
    );
    // Phase 14: a request from another origin is refused outright.
    expect(wrongOrigin.status).toBe(403);
    const wrongType = await report(
      copyId,
      cookie,
      { file: 'a.ts', active: true },
      {
        'Content-Type': 'text/plain',
      },
    );
    expect(wrongType.status).toBe(204);
    expect((await report(copyId, cookie, '{not json')).status).toBe(204);
    expect((await report(copyId, cookie, { file: 'a.ts', active: 'yes' })).status).toBe(204);
    expect((await report(copyId, cookie, 'x'.repeat(5000))).status).toBe(204);
    // Someone else's copy: noa's session can't report into mia's copy.
    const noaCopy = await makeCopy(noa, projectId);
    const noaCookie = await ideCookie(noa, noaCopy);
    expect((await report(copyId, noaCookie, { file: 'a.ts', active: true })).status).toBe(204);
    expect((await presenceOf(leader, projectId, mia)).state).toBe('offline');
    expect((await presenceOf(leader, projectId, noa)).state).toBe('offline');

    // Unsafe paths are kept as Active with no file.
    for (const file of ['../etc/passwd', '/etc/passwd', 'a\u0000b', 'x'.repeat(301), 'a/../../b']) {
      const res = await report(copyId, await fresh(), { file, active: true });
      expect(res.status).toBe(204);
      expect(await presenceOf(leader, projectId, mia)).toMatchObject({
        state: 'active',
        file: null,
      });
    }
    // A plain one after that is shown (plain text; the web app renders it as text).
    await report(copyId, await fresh(), { file: 'src/<b>x</b>.ts', active: true });
    expect((await presenceOf(leader, projectId, mia)).file).toBe('src/<b>x</b>.ts');
    // An inactive report: Online, no file.
    await report(copyId, await fresh(), { file: 'src/a.ts', active: false });
    expect(await presenceOf(leader, projectId, mia)).toMatchObject({
      state: 'online',
      file: null,
    });
    expect(cookie).toBeTruthy();
  });

  it('accepts at most one report per 5 s per IDE session', async () => {
    const { leader, mia, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    const cookie = await ideCookie(mia, copyId);
    await report(copyId, cookie, { file: 'first.ts', active: true });
    const extra = await report(copyId, cookie, { file: 'second.ts', active: true });
    expect([extra.status, extra.text]).toEqual([204, '']);
    expect((await presenceOf(leader, projectId, mia)).file).toBe('first.ts');
    // The limit is per session: another IDE session is counted separately.
    await report(copyId, await ideCookie(mia, copyId), { file: 'third.ts', active: true });
    expect((await presenceOf(leader, projectId, mia)).file).toBe('third.ts');
  });

  it('the off switch hides the file (now and in later reports) but still shows Active', async () => {
    const { leader, mia, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    await report(copyId, await ideCookie(mia, copyId), { file: 'secret.ts', active: true });
    expect((await presenceOf(leader, projectId, mia)).file).toBe('secret.ts');

    expect(PreferencesSchema.parse((await as(mia).get('/api/me/preferences')).body)).toEqual({
      shareOpenFile: true,
    });
    const lead = await connect(s, leader);
    await join(lead, projectId);
    const events = record(lead, 'presence');
    const off = await as(mia).patch('/api/me/preferences', { shareOpenFile: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ shareOpenFile: false });
    const hidden = await waitFor(events, (e) => e.member.user.id === mia.id);
    expect(hidden.member).toMatchObject({ state: 'active', file: null });

    await report(copyId, await ideCookie(mia, copyId), { file: 'other.ts', active: true });
    expect(await presenceOf(leader, projectId, mia)).toMatchObject({
      state: 'active',
      file: null,
    });
    expectError(
      await as(mia).patch('/api/me/preferences', { shareOpenFile: 'no' }),
      400,
      'validation_error',
    );
    expect((await request(s.server).get('/api/me/preferences')).status).toBe(401);
  });

  it('shows a lead working in a member’s copy', async () => {
    const { leader, mia, noa, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    await report(copyId, await ideCookie(leader, copyId), { file: 'fix.ts', active: true });
    expect(await presenceOf(noa, projectId, leader)).toMatchObject({
      state: 'active',
      file: 'fix.ts',
      copyOwner: { id: mia.id, name: 'Mia Member' },
    });
    expect((await presenceOf(noa, projectId, mia)).state).toBe('offline');
  });

  it('tells the project when an IDE report runs out', async () => {
    const { leader, mia, projectId } = await team3();
    const copyId = await makeCopy(mia, projectId);
    await report(copyId, await ideCookie(mia, copyId), { file: 'a.ts', active: true });
    const lead = await connect(s, leader);
    await join(lead, projectId);
    const events = record(lead, 'presence');
    // Simulate the 90 s passing.
    await getRedis().del(`${realtimeKey()}:ps:ide:${projectId}:${mia.id}`);
    expect(await sweepPresence(Date.now() + 91_000)).toBeGreaterThanOrEqual(1);
    const gone = await waitFor(events, (e) => e.member.user.id === mia.id);
    expect(gone.member.state).toBe('offline');
  });
});

describe('sanitizePresenceFile', () => {
  it('keeps safe relative paths only', () => {
    expect(sanitizePresenceFile('src/app.ts')).toBe('src/app.ts');
    expect(sanitizePresenceFile('a b/ü.ts')).toBe('a b/ü.ts');
    for (const bad of [
      null,
      42,
      '',
      '/abs',
      '\\abs',
      'C:/x',
      '..',
      'a/../b',
      'a\\..\\b',
      'a\nb',
      'a\u202eb',
      'x'.repeat(301),
    ]) {
      expect(sanitizePresenceFile(bad)).toBeNull();
    }
  });
});

describe('invalidations', () => {
  it('are sent only after the transaction commits, merged into one event', async () => {
    const { leader, projectId } = await team3();
    const socket = await connect(s, leader);
    await join(socket, projectId);
    const events = record(socket, 'invalidate');
    await expect(
      transaction(async (tx) => {
        await invalidateAfterCommit(tx, projectId, ['tasks']);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await transaction(async (tx) => {
      await invalidateAfterCommit(tx, projectId, ['tasks']);
      await invalidateAfterCommit(tx, projectId, ['submissions', 'tasks']);
      await sleep(200);
      expect(events).toEqual([]); // not before the commit
    });
    const event = await waitFor(events, () => true);
    expect(event.keys.sort()).toEqual(['submissions', 'tasks']);
    await sleep(200);
    expect(events).toHaveLength(1);
  });

  it('map every activity action to the data it changed', () => {
    const keys = (action: ActivityAction, target: string | null = 'x') =>
      invalidationsFor({ projectId: 'p', actorId: null, action, target });
    expect(keys('submission.created', 's1')).toEqual(['activity', 'submissions', 'submission:s1']);
    expect(keys('submission.merged', 's1')).toEqual(
      expect.arrayContaining(['submissions', 'submission:s1', 'repository', 'copy']),
    );
    expect(keys('copy.updated', 'u1')).toEqual(['activity', 'copy:u1']);
    expect(keys('task.moved')).toEqual(expect.arrayContaining(['tasks']));
    expect(keys('member.removed')).toEqual(
      expect.arrayContaining(['members', 'presence', 'tasks']),
    );
    expect(keys('project.renamed')).toEqual(['activity', 'members']);
    expect(keys('repository.imported')).toEqual(['activity', 'repository', 'copy', 'github']);
    expect(keys('github.published')).toEqual(['activity', 'github']);
    for (const key of [...keys('submission.created', 's'), ...keys('copy.helped', 'u')]) {
      expect(InvalidateKeySchema.safeParse(key).success, key).toBe(true);
    }
  });
});
