import { Router } from 'express';
import {
  canChangeRole,
  canLeave,
  canRemoveMember,
  canSetPermissions,
  DeleteProjectRequestSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  ProjectListResponseSchema,
  RenameProjectRequestSchema,
  TransferOwnershipRequestSchema,
  UpdateMemberRequestSchema,
  UpdateProjectSettingsRequestSchema,
  type MemberPermissions,
  type ProjectSettings,
} from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { prisma } from '../lib/prisma.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { listActivity, recordActivity } from '../activity/log.ts';
import { projectInvitationsRouter } from '../invitations/routes.ts';
import { forbidden, readPermissions, requireProjectAction } from './access.ts';
import { memberSelect, projectResponse, toMember, toProjectSummary } from './views.ts';

/** Mounted at /api/projects behind requireAuth. */
export const projectsRouter = Router();

const memberNotFound = () =>
  new HttpError(404, 'not_found', 'That person is not a member of this project');

projectsRouter.use('/:projectId/invitations', projectInvitationsRouter);

projectsRouter.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id },
    orderBy: { project: { createdAt: 'asc' } },
    select: {
      role: true,
      project: {
        select: { id: true, name: true, teamId: true, createdAt: true, team: true },
      },
    },
  });
  res.json(
    ProjectListResponseSchema.parse({
      projects: memberships.map((m) => toProjectSummary(m.project, m.role)),
    }),
  );
});

projectsRouter.get('/:projectId', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await projectResponse(access.project.id, access.userId));
});

projectsRouter.patch('/:projectId', async (req, res) => {
  const access = await requireProjectAction(req, 'project.rename');
  const { name } = parseBody(RenameProjectRequestSchema, req.body);
  const { project } = access;
  if (name !== project.name) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: project.id }, data: { name } });
      await recordActivity(tx, {
        projectId: project.id,
        actorId: access.userId,
        action: 'project.renamed',
        target: name,
        data: { from: project.name, to: name },
      });
    });
  }
  res.json(await projectResponse(project.id, access.userId));
});

projectsRouter.patch('/:projectId/settings', async (req, res) => {
  const access = await requireProjectAction(req, 'project.updateSettings');
  const changes = parseBody(UpdateProjectSettingsRequestSchema, req.body);
  const { project } = access;
  const next: ProjectSettings = { ...project.settings, ...changes };
  const changed: Record<string, { old: string | boolean; new: string | boolean }> = {};
  for (const key of Object.keys(next) as (keyof ProjectSettings)[]) {
    if (next[key] !== project.settings[key]) {
      changed[key] = { old: project.settings[key], new: next[key] };
    }
  }
  if (Object.keys(changed).length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: project.id }, data: { settings: next } });
      await recordActivity(tx, {
        projectId: project.id,
        actorId: access.userId,
        action: 'project.settings_changed',
        data: { changes: changed },
      });
    });
  }
  res.json(await projectResponse(project.id, access.userId));
});

projectsRouter.delete('/:projectId', async (req, res) => {
  const access = await requireProjectAction(req, 'project.delete');
  const { confirmName } = parseBody(DeleteProjectRequestSchema, req.body ?? {});
  if (confirmName !== access.project.name) {
    throw new HttpError(400, 'validation_error', 'Some fields are invalid', {
      confirmName: ['Type the project name exactly to confirm'],
    });
  }
  // Members, invitations and activity go with it (ON DELETE CASCADE).
  await prisma.project.delete({ where: { id: access.project.id } });
  res.status(204).end();
});

// ---------- Members ----------

projectsRouter.get('/:projectId/members', async (req, res) => {
  const access = await requireProjectAction(req);
  const rows = await prisma.projectMember.findMany({
    where: { projectId: access.project.id },
    // The project_role enum is declared leader, co_leader, member, so it sorts in that order.
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    select: memberSelect,
  });
  res.json(MemberListResponseSchema.parse({ members: rows.map(toMember) }));
});

projectsRouter.patch('/:projectId/members/:userId', async (req, res) => {
  const access = await requireProjectAction(req);
  const change = parseBody(UpdateMemberRequestSchema, req.body);
  const projectId = access.project.id;
  const targetId = req.params.userId;

  const member = await prisma.$transaction(async (tx) => {
    const target = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: targetId } },
      select: memberSelect,
    });
    if (!target) throw memberNotFound();
    if (change.role !== undefined && !canChangeRole(access.role, target.role)) {
      throw forbidden('Only the leader can promote or demote members');
    }
    if (change.permissions !== undefined && !canSetPermissions(access.role, target.role)) {
      throw forbidden('Permissions can only be changed for members, by the leader or a co-leader');
    }

    const oldPermissions = readPermissions(target.permissions);
    const newPermissions: MemberPermissions = { ...oldPermissions, ...change.permissions };
    const permissionChanges: Record<string, { old: boolean; new: boolean }> = {};
    for (const key of Object.keys(newPermissions) as (keyof MemberPermissions)[]) {
      if (newPermissions[key] !== oldPermissions[key]) {
        permissionChanges[key] = { old: oldPermissions[key], new: newPermissions[key] };
      }
    }
    const roleChanged = change.role !== undefined && change.role !== target.role;
    const permissionsChanged = Object.keys(permissionChanges).length > 0;
    if (!roleChanged && !permissionsChanged) return target;

    // The role condition makes this a no-op if a concurrent request made the target leader.
    const { count } = await tx.projectMember.updateMany({
      where: { projectId, userId: targetId, role: target.role },
      data: {
        ...(roleChanged ? { role: change.role } : {}),
        ...(permissionsChanged ? { permissions: newPermissions } : {}),
      },
    });
    if (count !== 1) throw new HttpError(409, 'conflict', 'The member changed; try again');

    const who = { name: target.user.name, email: target.user.email };
    if (roleChanged) {
      await recordActivity(tx, {
        projectId,
        actorId: access.userId,
        action: 'member.role_changed',
        target: targetId,
        data: { ...who, from: target.role, to: change.role ?? target.role },
      });
    }
    if (permissionsChanged) {
      await recordActivity(tx, {
        projectId,
        actorId: access.userId,
        action: 'member.permissions_changed',
        target: targetId,
        data: { ...who, changes: permissionChanges },
      });
    }
    return tx.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: targetId } },
      select: memberSelect,
    });
  });
  res.json(MemberResponseSchema.parse({ member: toMember(member) }));
});

projectsRouter.delete('/:projectId/members/:userId', async (req, res) => {
  const access = await requireProjectAction(req);
  const projectId = access.project.id;
  const targetId = req.params.userId;
  const leaving = targetId === access.userId;

  if (leaving && !canLeave(access.role)) {
    throw forbidden('The leader must transfer ownership to another member before leaving');
  }

  await prisma.$transaction(async (tx) => {
    const target = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: targetId } },
      select: memberSelect,
    });
    if (!target) throw memberNotFound();
    if (!leaving && !canRemoveMember(access.role, target.role)) {
      throw forbidden(
        access.role === 'co_leader'
          ? 'Co-leaders can remove members only'
          : 'You are not allowed to remove members',
      );
    }
    // Conditional on the role we checked, so a concurrent transfer can't remove the leader.
    const { count } = await tx.projectMember.deleteMany({
      where: { projectId, userId: targetId, role: target.role },
    });
    if (count !== 1) throw new HttpError(409, 'conflict', 'The member changed; try again');
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: leaving ? 'member.left' : 'member.removed',
      target: targetId,
      data: { name: target.user.name, email: target.user.email, role: target.role },
    });
  });
  res.status(204).end();
});

projectsRouter.post('/:projectId/transfer', async (req, res) => {
  const access = await requireProjectAction(req, 'project.transferOwnership');
  const { userId: targetId } = parseBody(TransferOwnershipRequestSchema, req.body);
  const projectId = access.project.id;
  if (targetId === access.userId) {
    throw new HttpError(400, 'validation_error', 'Some fields are invalid', {
      userId: ['Choose another member'],
    });
  }

  await prisma.$transaction(async (tx) => {
    const target = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: targetId } },
      select: memberSelect,
    });
    if (!target) throw memberNotFound();
    // Both updates are conditional: if a concurrent request changed either row, nothing is
    // committed, so the project always has exactly one leader.
    const demoted = await tx.projectMember.updateMany({
      where: { projectId, userId: access.userId, role: 'leader' },
      data: { role: 'co_leader' },
    });
    const promoted = await tx.projectMember.updateMany({
      where: { projectId, userId: targetId, role: { in: ['co_leader', 'member'] } },
      data: { role: 'leader' },
    });
    if (demoted.count !== 1 || promoted.count !== 1) {
      throw new HttpError(409, 'conflict', 'The project changed; try again');
    }
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'ownership.transferred',
      target: targetId,
      data: { name: target.user.name, email: target.user.email, previousRole: target.role },
    });
  });
  res.json(await projectResponse(projectId, access.userId));
});

// ---------- Activity ----------

projectsRouter.get('/:projectId/activity', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await listActivity(access.project.id));
});
