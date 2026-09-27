import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ActivityListResponseSchema,
  allowedActions,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_PROJECT_SETTINGS,
  MemberListResponseSchema,
  MemberResponseSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
} from '@devspace/shared';
import { prisma } from '../src/lib/prisma.ts';
import {
  addMember,
  app,
  as,
  cleanUp,
  createProject,
  createTeam,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';

afterAll(cleanUp);

async function members(user: TestUser, projectId: string) {
  const res = await as(user).get(`/api/projects/${projectId}/members`);
  expect(res.status).toBe(200);
  return MemberListResponseSchema.parse(res.body).members;
}

async function detail(user: TestUser, projectId: string) {
  const res = await as(user).get(`/api/projects/${projectId}`);
  expect(res.status).toBe(200);
  return ProjectResponseSchema.parse(res.body).project;
}

async function activity(user: TestUser, projectId: string) {
  const res = await as(user).get(`/api/projects/${projectId}/activity`);
  expect(res.status).toBe(200);
  return ActivityListResponseSchema.parse(res.body).entries;
}

describe('login required', () => {
  it('returns 401 on team, project and invitation routes without a session', async () => {
    for (const url of ['/api/teams', '/api/projects', '/api/invitations/abc']) {
      expectError(await request(app).get(url), 401, 'unauthenticated');
    }
    expectError(await request(app).post('/api/teams').send({ name: 'x' }), 401, 'unauthenticated');
  });
});

describe('teams and projects', () => {
  it('creates a team (owner + member) and a project (creator is leader, defaults stored)', async () => {
    const owner = await signUp('Owner');
    const teamRes = await as(owner).post('/api/teams', { name: '  Acme  ' });
    expect(teamRes.status).toBe(201);
    const { team } = TeamResponseSchema.parse(teamRes.body);
    expect(team).toMatchObject({ name: 'Acme', ownerId: owner.id, isOwner: true });
    expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: owner.id } })).toBe(1);

    const list = TeamListResponseSchema.parse((await as(owner).get('/api/teams')).body);
    expect(list.teams.map((t) => t.id)).toContain(team.id);

    const res = await as(owner).post(`/api/teams/${team.id}/projects`, { name: 'Website' });
    expect(res.status).toBe(201);
    const { project } = ProjectResponseSchema.parse(res.body);
    expect(project).toMatchObject({
      name: 'Website',
      teamId: team.id,
      teamName: 'Acme',
      myRole: 'leader',
      settings: DEFAULT_PROJECT_SETTINGS,
      myPermissions: DEFAULT_MEMBER_PERMISSIONS,
      memberCount: 1,
    });
    expect(project.allowedActions).toEqual(allowedActions('leader', DEFAULT_MEMBER_PERMISSIONS));

    const row = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: owner.id } },
    });
    expect(row.role).toBe('leader');
    expect(row.permissions).toEqual(DEFAULT_MEMBER_PERMISSIONS);
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(stored.repoPath).toBeNull();

    const teamDetail = TeamDetailResponseSchema.parse(
      (await as(owner).get(`/api/teams/${team.id}`)).body,
    );
    expect(teamDetail.projects.map((p) => p.id)).toEqual([project.id]);
    const projects = ProjectListResponseSchema.parse((await as(owner).get('/api/projects')).body);
    expect(projects.projects.find((p) => p.id === project.id)?.myRole).toBe('leader');
  });

  it('validates names', async () => {
    const owner = await signUp();
    const res = await as(owner).post('/api/teams', { name: '   ' });
    expectError(res, 400, 'validation_error');
    expect(res.body.fields.name).toContain('Enter a name');
  });

  it('hides teams and projects from non-members (404)', async () => {
    const owner = await signUp();
    const outsider = await signUp('Outsider');
    const team = await createTeam(owner);
    const project = await createProject(owner, team.id);
    const base = `/api/projects/${project.id}`;
    const o = as(outsider);

    expectError(await o.get(`/api/teams/${team.id}`), 404, 'not_found');
    expectError(await o.post(`/api/teams/${team.id}/projects`, { name: 'X' }), 404, 'not_found');
    for (const res of [
      await o.get(base),
      await o.patch(base, { name: 'Hacked' }),
      await o.patch(`${base}/settings`, { requireApproval: false }),
      await o.delete(base, { confirmName: 'Project' }),
      await o.get(`${base}/members`),
      await o.patch(`${base}/members/${owner.id}`, { role: 'member' }),
      await o.delete(`${base}/members/${owner.id}`),
      await o.post(`${base}/transfer`, { userId: outsider.id }),
      await o.get(`${base}/activity`),
      await o.post(`${base}/invitations`, { email: outsider.email }),
      await o.get(`${base}/invitations`),
      await o.get('/api/projects/does-not-exist'),
    ]) {
      expectError(res, 404, 'not_found');
    }
    const list = ProjectListResponseSchema.parse((await o.get('/api/projects')).body);
    expect(list.projects.some((p) => p.id === project.id)).toBe(false);
  });
});

describe('roles and permissions', () => {
  let leader: TestUser;
  let colead: TestUser;
  let colead2: TestUser;
  let member: TestUser;
  let member2: TestUser;
  let projectId: string;
  let base: string;

  beforeAll(async () => {
    leader = await signUp('Leader');
    colead = await signUp('Co One');
    colead2 = await signUp('Co Two');
    member = await signUp('Member');
    member2 = await signUp('Member Two');
    const team = await createTeam(leader);
    projectId = (await createProject(leader, team.id, 'Roles')).id;
    base = `/api/projects/${projectId}`;
    for (const u of [colead, colead2, member, member2]) await addMember(leader, projectId, u);
    for (const u of [colead, colead2]) {
      const res = await as(leader).patch(`${base}/members/${u.id}`, { role: 'co_leader' });
      expect(res.status).toBe(200);
      expect(MemberResponseSchema.parse(res.body).member.role).toBe('co_leader');
    }
  });

  it('lists members leader first, then co-leaders, then members by join time', async () => {
    const list = await members(member, projectId);
    expect(list.map((m) => m.userId)).toEqual([
      leader.id,
      colead.id,
      colead2.id,
      member.id,
      member2.id,
    ]);
    expect(list[0]).toMatchObject({ name: 'Leader', email: leader.email, role: 'leader' });
    expect((await detail(member, projectId)).memberCount).toBe(5);
  });

  it('a member with default permissions gets 403 on lead actions', async () => {
    const m = as(member);
    for (const res of [
      await m.patch(base, { name: 'Nope' }),
      await m.patch(`${base}/settings`, { requireApproval: false }),
      await m.post(`${base}/invitations`, { email: 'someone@example.test' }),
      await m.get(`${base}/invitations`),
      await m.patch(`${base}/members/${member2.id}`, { permissions: { comment: true } }),
      await m.patch(`${base}/members/${member2.id}`, { role: 'co_leader' }),
      await m.delete(`${base}/members/${member2.id}`),
      await m.post(`${base}/transfer`, { userId: member2.id }),
      await m.delete(base, { confirmName: 'Roles' }),
    ]) {
      expectError(res, 403, 'forbidden');
    }
    const d = await detail(member, projectId);
    expect(d.myRole).toBe('member');
    expect(d.allowedActions).toEqual(['project.view']);
  });

  it('a co-leader can invite and manage members but not co-leaders, delete or transfer', async () => {
    const c = as(colead);
    const invite = await c.post(`${base}/invitations`, { email: 'friend@example.test' });
    expect(invite.status).toBe(201);
    const perm = await c.patch(`${base}/members/${member.id}`, { permissions: { comment: true } });
    expect(perm.status).toBe(200);

    expectError(await c.delete(`${base}/members/${colead2.id}`), 403, 'forbidden');
    expectError(
      await c.patch(`${base}/members/${colead2.id}`, { role: 'member' }),
      403,
      'forbidden',
    );
    expectError(
      await c.patch(`${base}/members/${member.id}`, { role: 'co_leader' }),
      403,
      'forbidden',
    );
    expectError(
      await c.patch(`${base}/members/${colead2.id}`, { permissions: { approve: true } }),
      403,
      'forbidden',
    );
    expectError(await c.delete(`${base}/members/${leader.id}`), 403, 'forbidden');
    expectError(await c.delete(base, { confirmName: 'Roles' }), 403, 'forbidden');
    expectError(await c.post(`${base}/transfer`, { userId: colead.id }), 403, 'forbidden');

    const renamed = await c.patch(base, { name: 'Roles' });
    expect(renamed.status).toBe(200);
  });

  it('permission toggles persist and change allowedActions', async () => {
    const res = await as(leader).patch(`${base}/members/${member2.id}`, {
      permissions: { approve: true, createTasks: true },
    });
    expect(res.status).toBe(200);
    const { member: m } = MemberResponseSchema.parse(res.body);
    expect(m.permissions).toEqual({
      ...DEFAULT_MEMBER_PERMISSIONS,
      approve: true,
      createTasks: true,
    });

    const row = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: member2.id } },
    });
    expect(row.permissions).toEqual(m.permissions);
    const d = await detail(member2, projectId);
    expect(d.myPermissions).toEqual(m.permissions);
    expect(d.allowedActions).toEqual(['project.view', 'submission.approve', 'task.create']);
  });

  it('settings JSON missing keys falls back to defaults merged with stored values', async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { settings: { requireApproval: false, bogus: 1, githubMode: 'nope' } },
    });
    const d = await detail(leader, projectId);
    expect(d.settings).toEqual({ ...DEFAULT_PROJECT_SETTINGS, requireApproval: false });
    await prisma.project.update({
      where: { id: projectId },
      data: { settings: DEFAULT_PROJECT_SETTINGS },
    });
  });

  it('the leader can promote, demote and remove co-leaders', async () => {
    const extra = await signUp('Extra');
    await addMember(leader, projectId, extra);
    const l = as(leader);
    expect((await l.patch(`${base}/members/${extra.id}`, { role: 'co_leader' })).status).toBe(200);
    expect((await l.patch(`${base}/members/${extra.id}`, { role: 'member' })).status).toBe(200);
    expect((await l.patch(`${base}/members/${extra.id}`, { role: 'co_leader' })).status).toBe(200);
    expect((await l.delete(`${base}/members/${extra.id}`)).status).toBe(204);
    expect((await members(leader, projectId)).some((x) => x.userId === extra.id)).toBe(false);
    expectError(await as(extra).get(base), 404, 'not_found');
    expectError(await l.delete(`${base}/members/${extra.id}`), 404, 'not_found');
    expectError(await l.patch(`${base}/members/${extra.id}`, { role: 'member' }), 404, 'not_found');
  });

  it('a role change can never create or remove the leader', async () => {
    const l = as(leader);
    expectError(
      await l.patch(`${base}/members/${leader.id}`, { role: 'member' }),
      403,
      'forbidden',
    );
    expectError(
      await l.patch(`${base}/members/${member.id}`, { role: 'leader' }),
      400,
      'validation_error',
    );
    expectError(await l.patch(`${base}/members/${member.id}`, {}), 400, 'validation_error');
    expect(await prisma.projectMember.count({ where: { projectId, role: 'leader' } })).toBe(1);
  });

  it('the leader cannot leave; everyone else can', async () => {
    const res = await as(leader).delete(`${base}/members/${leader.id}`);
    expectError(res, 403, 'forbidden');
    expect(res.body.message).toMatch(/transfer ownership/i);

    const leaver = await signUp('Leaver');
    await addMember(colead, projectId, leaver);
    expect((await as(leaver).delete(`${base}/members/${leaver.id}`)).status).toBe(204);
    expectError(await as(leaver).get(base), 404, 'not_found');

    const coLeaver = await signUp('Co Leaver');
    await addMember(leader, projectId, coLeaver);
    await as(leader).patch(`${base}/members/${coLeaver.id}`, { role: 'co_leader' });
    expect((await as(coLeaver).delete(`${base}/members/${coLeaver.id}`)).status).toBe(204);

    const entries = await activity(leader, projectId);
    expect(entries.filter((e) => e.action === 'member.left').map((e) => e.target)).toEqual([
      coLeaver.id,
      leaver.id,
    ]);
  });
});

describe('transfer ownership', () => {
  it('leaves exactly one leader; the old leader becomes a co-leader', async () => {
    const leader = await signUp('Old Leader');
    const next = await signUp('New Leader');
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id, 'Handover');
    const base = `/api/projects/${project.id}`;
    await addMember(leader, project.id, next);

    expectError(
      await as(leader).post(`${base}/transfer`, { userId: leader.id }),
      400,
      'validation_error',
    );
    const stranger = await signUp();
    expectError(
      await as(leader).post(`${base}/transfer`, { userId: stranger.id }),
      404,
      'not_found',
    );

    const res = await as(leader).post(`${base}/transfer`, { userId: next.id });
    expect(res.status).toBe(200);
    const { project: after } = ProjectResponseSchema.parse(res.body);
    expect(after.myRole).toBe('co_leader');
    expect(after.allowedActions).not.toContain('project.delete');

    const list = await members(next, project.id);
    expect(list.filter((m) => m.role === 'leader').map((m) => m.userId)).toEqual([next.id]);
    expect(list.find((m) => m.userId === leader.id)?.role).toBe('co_leader');
    expect(
      await prisma.projectMember.count({ where: { projectId: project.id, role: 'leader' } }),
    ).toBe(1);

    // The old leader can now leave; the new one can't.
    expectError(await as(next).delete(`${base}/members/${next.id}`), 403, 'forbidden');
    expectError(await as(leader).post(`${base}/transfer`, { userId: next.id }), 403, 'forbidden');

    const entries = await activity(next, project.id);
    expect(entries[0]).toMatchObject({
      action: 'ownership.transferred',
      actorId: leader.id,
      actorName: 'Old Leader',
      target: next.id,
    });
  });

  it('concurrent transfers still leave exactly one leader', async () => {
    const leader = await signUp();
    const a = await signUp();
    const b = await signUp();
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id);
    await addMember(leader, project.id, a);
    await addMember(leader, project.id, b);
    const base = `/api/projects/${project.id}`;
    const results = await Promise.all([
      as(leader).post(`${base}/transfer`, { userId: a.id }),
      as(leader).post(`${base}/transfer`, { userId: b.id }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      await prisma.projectMember.count({ where: { projectId: project.id, role: 'leader' } }),
    ).toBe(1);
  });
});

describe('rename, settings and delete', () => {
  it('renames, updates settings (partial) and records activity newest first', async () => {
    const leader = await signUp('Boss');
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id, 'Alpha');
    const base = `/api/projects/${project.id}`;
    const l = as(leader);

    const renamed = await l.patch(base, { name: 'Beta' });
    expect(ProjectResponseSchema.parse(renamed.body).project.name).toBe('Beta');

    expectError(await l.patch(`${base}/settings`, {}), 400, 'validation_error');
    expectError(
      await l.patch(`${base}/settings`, { copyUpdateMode: 'sometimes' }),
      400,
      'validation_error',
    );
    const res = await l.patch(`${base}/settings`, {
      requireApproval: false,
      githubMode: 'keep_updated',
    });
    expect(res.status).toBe(200);
    const { project: after } = ProjectResponseSchema.parse(res.body);
    expect(after.settings).toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
      requireApproval: false,
      githubMode: 'keep_updated',
    });
    const stored = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.settings).toEqual(after.settings);

    const entries = await activity(leader, project.id);
    expect(entries.map((e) => e.action)).toEqual([
      'project.settings_changed',
      'project.renamed',
      'project.created',
    ]);
    expect(entries[0]!.data).toEqual({
      changes: {
        requireApproval: { old: true, new: false },
        githubMode: { old: 'publish_once', new: 'keep_updated' },
      },
    });
    expect(entries[1]!.data).toEqual({ from: 'Alpha', to: 'Beta' });
    expect(entries.every((e) => e.actorName === 'Boss')).toBe(true);
  });

  it('returns at most 50 activity entries', async () => {
    const leader = await signUp();
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id);
    await prisma.activityLog.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        projectId: project.id,
        actorId: leader.id,
        action: 'project.renamed',
        data: { i },
        createdAt: new Date(Date.now() + (i + 1) * 1000),
      })),
    });
    const entries = await activity(leader, project.id);
    expect(entries).toHaveLength(50);
    expect(entries[0]!.data).toEqual({ i: 59 });
  });

  it('delete needs the exact name and cascades to members, invitations and activity', async () => {
    const leader = await signUp();
    const member = await signUp();
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id, 'Doomed');
    const base = `/api/projects/${project.id}`;
    await addMember(leader, project.id, member);
    await as(leader).post(`${base}/invitations`, { email: 'pending@example.test' });

    let res = await as(leader).delete(base, { confirmName: 'doomed' });
    expectError(res, 400, 'validation_error');
    expect(res.body.fields.confirmName).toBeDefined();
    expectError(await as(leader).delete(base), 400, 'validation_error');
    expectError(await as(member).delete(base, { confirmName: 'Doomed' }), 403, 'forbidden');

    res = await as(leader).delete(base, { confirmName: 'Doomed' });
    expect(res.status).toBe(204);
    const where = { projectId: project.id };
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
    expect(await prisma.projectMember.count({ where })).toBe(0);
    expect(await prisma.invitation.count({ where })).toBe(0);
    expect(await prisma.activityLog.count({ where })).toBe(0);
    expectError(await as(leader).get(base), 404, 'not_found');
    // The team stays.
    expect((await as(leader).get(`/api/teams/${team.id}`)).status).toBe(200);
  });
});

describe('CSRF baseline for DELETE', () => {
  it('still rejects a DELETE that carries a non-JSON body', async () => {
    const leader = await signUp();
    const team = await createTeam(leader);
    const project = await createProject(leader, team.id, 'Keep');
    const res = await request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Cookie', leader.cookie)
      .type('form')
      .send('confirmName=Keep');
    expectError(res, 415, 'unsupported_media_type');
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
  });
});
