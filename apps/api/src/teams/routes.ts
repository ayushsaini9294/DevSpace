import { Router } from 'express';
import {
  CreateProjectRequestSchema,
  CreateTeamRequestSchema,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_PROJECT_SETTINGS,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
  type Team,
} from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { prisma } from '../lib/prisma.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { recordActivity } from '../activity/log.ts';
import { projectResponse, toProjectSummary } from '../projects/views.ts';

/** Mounted at /api/teams behind requireAuth. */
export const teamsRouter = Router();

const teamNotFound = () => new HttpError(404, 'not_found', 'Team not found');

function toTeam(
  team: { id: string; name: string; ownerId: string; createdAt: Date },
  userId: string,
): Team {
  return {
    id: team.id,
    name: team.name,
    ownerId: team.ownerId,
    isOwner: team.ownerId === userId,
    createdAt: team.createdAt.toISOString(),
  };
}

/** The team, if `userId` is a member of it; otherwise 404 (never reveals the team exists). */
async function findMemberTeam(teamId: string, userId: string) {
  const row = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { team: true },
  });
  if (!row) throw teamNotFound();
  return row.team;
}

teamsRouter.post('/', async (req, res) => {
  const user = req.user as AuthUser;
  const { name } = parseBody(CreateTeamRequestSchema, req.body);
  // The owner is also the team's first member (nested write: one transaction).
  const team = await prisma.team.create({
    data: { name, ownerId: user.id, members: { create: { userId: user.id } } },
  });
  res.status(201).json(TeamResponseSchema.parse({ team: toTeam(team, user.id) }));
});

teamsRouter.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const rows = await prisma.teamMember.findMany({
    where: { userId: user.id },
    orderBy: { joinedAt: 'asc' },
    select: { team: true },
  });
  res.json(TeamListResponseSchema.parse({ teams: rows.map((r) => toTeam(r.team, user.id)) }));
});

teamsRouter.get('/:teamId', async (req, res) => {
  const user = req.user as AuthUser;
  const team = await findMemberTeam(req.params.teamId, user.id);
  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id, project: { teamId: team.id } },
    orderBy: { project: { createdAt: 'asc' } },
    select: {
      role: true,
      project: {
        select: { id: true, name: true, teamId: true, createdAt: true, team: true },
      },
    },
  });
  res.json(
    TeamDetailResponseSchema.parse({
      team: toTeam(team, user.id),
      projects: memberships.map((m) => toProjectSummary(m.project, m.role)),
    }),
  );
});

teamsRouter.post('/:teamId/projects', async (req, res) => {
  const user = req.user as AuthUser;
  const team = await findMemberTeam(req.params.teamId, user.id);
  const { name } = parseBody(CreateProjectRequestSchema, req.body);

  const body = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        teamId: team.id,
        name,
        settings: DEFAULT_PROJECT_SETTINGS,
        // Leaders ignore the stored permissions, but the row always holds a full set.
        members: {
          create: { userId: user.id, role: 'leader', permissions: DEFAULT_MEMBER_PERMISSIONS },
        },
      },
      select: { id: true },
    });
    await recordActivity(tx, {
      projectId: project.id,
      actorId: user.id,
      action: 'project.created',
      target: name,
      data: { name },
    });
    return projectResponse(project.id, user.id, tx);
  });
  res.status(201).json(body);
});
