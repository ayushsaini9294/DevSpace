import type { Request } from 'express';
import {
  can,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_PROJECT_SETTINGS,
  MemberPermissionsSchema,
  ProjectSettingsSchema,
  type MemberPermissions,
  type ProjectAction,
  type ProjectRole,
  type ProjectSettings,
} from '@devspace/shared';
import type { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.ts';
import type { AuthUser } from '../auth/session.ts';
import { prisma } from '../lib/prisma.ts';
import { HttpError } from '../lib/http-error.ts';

/** Anything that can run queries: the shared client or an interactive transaction. */
export type Db = typeof prisma | Prisma.TransactionClient;

export const projectNotFound = () => new HttpError(404, 'not_found', 'Project not found');
export const forbidden = (message = 'You are not allowed to do this') =>
  new HttpError(403, 'forbidden', message);

/**
 * Reads a JSON object stored in the database against a shared object schema. Every key the
 * schema knows starts from `defaults`; a stored value replaces it only when it is valid, so
 * old rows missing a newer key (or holding a bad value) still produce a complete object.
 */
function readStoredObject<T extends Record<string, unknown>>(
  schema: z.ZodObject,
  defaults: T,
  stored: unknown,
): T {
  const result: Record<string, unknown> = { ...defaults };
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    const source = stored as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      const field = schema.shape[key];
      if (field && key in source && field.safeParse(source[key]).success) {
        result[key] = source[key];
      }
    }
  }
  return schema.parse(result) as T;
}

export function readSettings(stored: unknown): ProjectSettings {
  return readStoredObject(ProjectSettingsSchema, DEFAULT_PROJECT_SETTINGS, stored);
}

export function readPermissions(stored: unknown): MemberPermissions {
  return readStoredObject(MemberPermissionsSchema, DEFAULT_MEMBER_PERMISSIONS, stored);
}

/** The caller's view of one project: the project, its team, and the caller's role there. */
export interface ProjectAccess {
  userId: string;
  role: ProjectRole;
  permissions: MemberPermissions;
  project: {
    id: string;
    name: string;
    teamId: string;
    teamName: string;
    repoPath: string | null;
    settings: ProjectSettings;
    createdAt: Date;
  };
}

/**
 * Loads the caller's membership of a project. Not a member (or no such project) → 404, so
 * the response never reveals that a project exists.
 */
export async function getProjectAccess(
  projectId: string,
  userId: string,
  db: Db = prisma,
): Promise<ProjectAccess> {
  const row = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: {
      role: true,
      permissions: true,
      project: {
        select: {
          id: true,
          name: true,
          teamId: true,
          repoPath: true,
          settings: true,
          createdAt: true,
          team: { select: { name: true } },
        },
      },
    },
  });
  if (!row) throw projectNotFound();
  const { project } = row;
  return {
    userId,
    role: row.role,
    permissions: readPermissions(row.permissions),
    project: {
      id: project.id,
      name: project.name,
      teamId: project.teamId,
      teamName: project.team.name,
      repoPath: project.repoPath,
      settings: readSettings(project.settings),
      createdAt: project.createdAt,
    },
  };
}

/** 403 `forbidden` unless the shared `can` allows the action. */
export function assertCan(access: ProjectAccess, action: ProjectAction): void {
  if (!can(access.role, access.permissions, action)) throw forbidden();
}

/**
 * For routes under /api/projects/:projectId (after requireAuth): loads the caller's access to
 * the project and checks `action`. 404 when not a member, 403 when not allowed.
 */
export async function requireProjectAction(
  req: Request,
  action: ProjectAction = 'project.view',
): Promise<ProjectAccess> {
  const user = req.user as AuthUser;
  const projectId = req.params.projectId;
  if (typeof projectId !== 'string') throw projectNotFound();
  const access = await getProjectAccess(projectId, user.id);
  assertCan(access, action);
  return access;
}
