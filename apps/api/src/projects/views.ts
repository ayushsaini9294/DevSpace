import {
  allowedActions,
  ProjectMemberSchema,
  ProjectResponseSchema,
  ProjectSummarySchema,
  type ProjectMember,
  type ProjectRole,
  type ProjectSummary,
} from '@devspace/shared';
import { prisma } from '../lib/prisma.ts';
import { getProjectAccess, readPermissions, type Db } from './access.ts';

interface SummaryInput {
  id: string;
  name: string;
  teamId: string;
  team: { name: string };
  createdAt: Date;
}

export function toProjectSummary(project: SummaryInput, myRole: ProjectRole): ProjectSummary {
  return ProjectSummarySchema.parse({
    id: project.id,
    name: project.name,
    teamId: project.teamId,
    teamName: project.team.name,
    myRole,
    createdAt: project.createdAt.toISOString(),
  });
}

/** The full ProjectResponse for `userId`, read fresh from the database. */
export async function projectResponse(projectId: string, userId: string, db: Db = prisma) {
  const access = await getProjectAccess(projectId, userId, db);
  const memberCount = await db.projectMember.count({ where: { projectId } });
  const { project } = access;
  return ProjectResponseSchema.parse({
    project: {
      id: project.id,
      name: project.name,
      teamId: project.teamId,
      teamName: project.teamName,
      myRole: access.role,
      createdAt: project.createdAt.toISOString(),
      settings: project.settings,
      myPermissions: access.permissions,
      allowedActions: allowedActions(access.role, access.permissions),
      memberCount,
    },
  });
}

export const memberSelect = {
  userId: true,
  role: true,
  permissions: true,
  joinedAt: true,
  user: { select: { name: true, email: true } },
} as const;

interface MemberRow {
  userId: string;
  role: ProjectRole;
  permissions: unknown;
  joinedAt: Date;
  user: { name: string; email: string };
}

export function toMember(row: MemberRow): ProjectMember {
  return ProjectMemberSchema.parse({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    permissions: readPermissions(row.permissions),
    joinedAt: row.joinedAt.toISOString(),
  });
}
