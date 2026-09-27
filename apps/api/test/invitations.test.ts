import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  AcceptInvitationResponseSchema,
  ActivityListResponseSchema,
  CreateInvitationResponseSchema,
  DEFAULT_MEMBER_PERMISSIONS,
  INVITATION_TTL_DAYS,
  InvitationListResponseSchema,
  InvitationPreviewResponseSchema,
  MemberListResponseSchema,
  ProjectListResponseSchema,
  TeamListResponseSchema,
} from '@devspace/shared';
import { prisma } from '../src/lib/prisma.ts';
import { hashInvitationToken } from '../src/invitations/routes.ts';
import {
  app,
  as,
  cleanUp,
  createProject,
  createTeam,
  expectError,
  signUp,
  uniqueEmail,
  type TestUser,
} from './helpers.ts';

afterAll(cleanUp);

async function setup(projectName = 'Invites') {
  const leader = await signUp('Lead Person');
  const team = await createTeam(leader, 'Invite Team');
  const project = await createProject(leader, team.id, projectName);
  return { leader, team, project, base: `/api/projects/${project.id}/invitations` };
}

async function invite(inviter: TestUser, base: string, email: string) {
  const res = await as(inviter).post(base, { email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const body = CreateInvitationResponseSchema.parse(res.body);
  const token = body.path.replace(/^\/invite\//, '');
  return { ...body, token };
}

describe('invitation flow', () => {
  it('create → preview → accept: the member joins the project and the team', async () => {
    const { leader, team, project, base } = await setup();
    const invitee = await signUp('Newbie', uniqueEmail('Mixed'));

    const before = Date.now();
    // Different case than the account: emails match case-insensitively.
    const created = await invite(leader, base, invitee.email.toUpperCase());
    expect(created.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(created.invitation).toMatchObject({
      email: invitee.email,
      invitedByName: 'Lead Person',
    });
    const ttl = Date.parse(created.invitation.expiresAt) - before;
    expect(Math.abs(ttl - INVITATION_TTL_DAYS * 86_400_000)).toBeLessThan(60_000);

    // Only the hash is stored.
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: created.invitation.id } });
    expect(row.tokenHash).toBe(hashInvitationToken(created.token));
    expect(row.tokenHash).not.toContain(created.token);
    expect(await prisma.invitation.count({ where: { tokenHash: created.token } })).toBe(0);

    const pending = InvitationListResponseSchema.parse((await as(leader).get(base)).body);
    expect(pending.invitations.map((i) => i.id)).toEqual([created.invitation.id]);

    const preview = await as(invitee).get(`/api/invitations/${created.token}`);
    expect(preview.status).toBe(200);
    expect(InvitationPreviewResponseSchema.parse(preview.body)).toEqual({
      projectName: 'Invites',
      teamName: 'Invite Team',
      invitedByName: 'Lead Person',
      email: invitee.email,
      expiresAt: created.invitation.expiresAt,
      matchesYou: true,
    });
    const otherPreview = await as(leader).get(`/api/invitations/${created.token}`);
    expect(otherPreview.body.matchesYou).toBe(false);

    const accept = await as(invitee).post(`/api/invitations/${created.token}/accept`);
    expect(accept.status).toBe(200);
    expect(AcceptInvitationResponseSchema.parse(accept.body)).toEqual({ projectId: project.id });

    const members = MemberListResponseSchema.parse(
      (await as(leader).get(`/api/projects/${project.id}/members`)).body,
    ).members;
    expect(members.find((m) => m.userId === invitee.id)).toMatchObject({
      role: 'member',
      permissions: DEFAULT_MEMBER_PERMISSIONS,
      email: invitee.email,
    });
    const projects = ProjectListResponseSchema.parse((await as(invitee).get('/api/projects')).body);
    expect(projects.projects).toEqual([
      expect.objectContaining({ id: project.id, myRole: 'member', teamName: 'Invite Team' }),
    ]);
    const teams = TeamListResponseSchema.parse((await as(invitee).get('/api/teams')).body);
    expect(teams.teams).toEqual([expect.objectContaining({ id: team.id, isOwner: false })]);
    expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: invitee.id } })).toBe(
      1,
    );

    const stored = await prisma.invitation.findUniqueOrThrow({
      where: { id: created.invitation.id },
    });
    expect(stored.status).toBe('accepted');
    expect(stored.acceptedById).toBe(invitee.id);
    expect(stored.acceptedAt).not.toBeNull();

    // Used: 409 for preview and accept; no longer listed as pending.
    expectError(await as(invitee).get(`/api/invitations/${created.token}`), 409, 'invitation_used');
    expectError(
      await as(invitee).post(`/api/invitations/${created.token}/accept`),
      409,
      'invitation_used',
    );
    expect((await as(leader).get(base)).body.invitations).toEqual([]);

    const activity = ActivityListResponseSchema.parse(
      (await as(leader).get(`/api/projects/${project.id}/activity`)).body,
    ).entries;
    expect(activity.map((e) => e.action)).toEqual([
      'member.joined',
      'member.invited',
      'project.created',
    ]);
    expect(activity[0]).toMatchObject({
      actorId: invitee.id,
      actorName: 'Newbie',
      target: invitee.id,
    });
    expect(activity[1]).toMatchObject({ actorId: leader.id, target: invitee.email });
  });

  it('rejects the wrong account with 403 wrong_account', async () => {
    const { leader, base } = await setup();
    const { token } = await invite(leader, base, uniqueEmail());
    const other = await signUp();
    const res = await as(other).post(`/api/invitations/${token}/accept`);
    expectError(res, 403, 'wrong_account');
    expect(
      await prisma.invitation.count({
        where: { tokenHash: hashInvitationToken(token), status: 'pending' },
      }),
    ).toBe(1);
  });

  it('returns 410 for an expired invitation', async () => {
    const { leader, base } = await setup();
    const invitee = await signUp();
    const { token } = await invite(leader, base, invitee.email);
    await prisma.invitation.update({
      where: { tokenHash: hashInvitationToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expectError(await as(invitee).get(`/api/invitations/${token}`), 410, 'invitation_expired');
    expectError(
      await as(invitee).post(`/api/invitations/${token}/accept`),
      410,
      'invitation_expired',
    );
    expect((await as(leader).get(base)).body.invitations).toEqual([]);
  });

  it('re-inviting revokes the old link', async () => {
    const { leader, base } = await setup();
    const invitee = await signUp();
    const first = await invite(leader, base, invitee.email);
    const second = await invite(leader, base, invitee.email);
    expectError(await as(invitee).get(`/api/invitations/${first.token}`), 404, 'not_found');
    expectError(await as(invitee).post(`/api/invitations/${first.token}/accept`), 404, 'not_found');
    const list = InvitationListResponseSchema.parse((await as(leader).get(base)).body);
    expect(list.invitations.map((i) => i.id)).toEqual([second.invitation.id]);
    expect((await as(invitee).post(`/api/invitations/${second.token}/accept`)).status).toBe(200);
  });

  it('cancelled invitations return 404 and are logged', async () => {
    const { leader, project, base } = await setup();
    const invitee = await signUp();
    const { token, invitation } = await invite(leader, base, invitee.email);
    // DELETE with no body and no Content-Type is allowed.
    const res = await request(app).delete(`${base}/${invitation.id}`).set('Cookie', leader.cookie);
    expect(res.status).toBe(204);
    expectError(await as(leader).delete(`${base}/${invitation.id}`), 404, 'not_found');
    expectError(await as(invitee).get(`/api/invitations/${token}`), 404, 'not_found');
    expectError(await as(invitee).post(`/api/invitations/${token}/accept`), 404, 'not_found');
    const entries = ActivityListResponseSchema.parse(
      (await as(leader).get(`/api/projects/${project.id}/activity`)).body,
    ).entries;
    expect(entries[0]).toMatchObject({ action: 'invitation.cancelled', target: invitee.email });
  });

  it('unknown tokens return 404', async () => {
    const user = await signUp();
    expectError(await as(user).get('/api/invitations/not-a-real-token'), 404, 'not_found');
    expectError(await as(user).post('/api/invitations/not-a-real-token/accept'), 404, 'not_found');
  });

  it('409 already_member when inviting a member, or accepting while already a member', async () => {
    const { leader, base } = await setup();
    expectError(
      await as(leader).post(base, { email: leader.email.toUpperCase() }),
      409,
      'already_member',
    );

    const invitee = await signUp();
    const a = await invite(leader, base, invitee.email);
    // Simulate a second pending link created before the first was accepted.
    const raw = 'second-token-for-already-member-test-' + invitee.id;
    await prisma.invitation.create({
      data: {
        projectId: (await prisma.invitation.findUniqueOrThrow({ where: { id: a.invitation.id } }))
          .projectId,
        email: invitee.email,
        tokenHash: hashInvitationToken(raw),
        invitedById: leader.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await as(invitee).post(`/api/invitations/${a.token}/accept`)).status).toBe(200);
    expectError(await as(invitee).post(`/api/invitations/${raw}/accept`), 409, 'already_member');
    expectError(await as(leader).post(base, { email: invitee.email }), 409, 'already_member');
  });

  it('validates the invited email', async () => {
    const { leader, base } = await setup();
    const res = await as(leader).post(base, { email: 'nope' });
    expectError(res, 400, 'validation_error');
    expect(res.body.fields.email).toBeDefined();
  });
});
