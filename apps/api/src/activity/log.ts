import { ActivityListResponseSchema, type ActivityEntry } from '@devspace/shared';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';
import type { Db } from '../projects/access.ts';

/** Every action written to the activity log. */
export type ActivityAction =
  | 'project.created'
  | 'project.renamed'
  | 'project.settings_changed'
  | 'member.invited'
  | 'invitation.cancelled'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'member.role_changed'
  | 'member.permissions_changed'
  | 'ownership.transferred'
  | 'repository.created'
  | 'repository.imported'
  | 'repository.import_failed'
  | 'copy.created'
  | 'submission.created'
  | 'submission.updated'
  | 'submission.commented'
  | 'submission.reviewed'
  | 'submission.suggestion_accepted'
  | 'submission.suggestion_rejected'
  | 'submission.rejected'
  | 'submission.closed';

export interface ActivityInput {
  projectId: string;
  actorId: string | null;
  action: ActivityAction;
  target?: string | null;
  data?: Prisma.InputJsonObject;
}

/**
 * Appends one entry. The activity log is append-only: application code only ever inserts
 * rows (they disappear only when their project is deleted). Pass the transaction client so
 * the entry is written together with the change it describes.
 */
export async function recordActivity(db: Db, input: ActivityInput): Promise<void> {
  await db.activityLog.create({
    data: {
      projectId: input.projectId,
      actorId: input.actorId,
      action: input.action,
      target: input.target ?? null,
      data: input.data ?? {},
    },
  });
}

export const ACTIVITY_PAGE_SIZE = 50;

/** The project's latest entries, newest first. */
export async function listActivity(projectId: string) {
  const rows = await prisma.activityLog.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ACTIVITY_PAGE_SIZE,
    select: {
      id: true,
      action: true,
      actorId: true,
      target: true,
      data: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  const entries: ActivityEntry[] = rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    actorName: row.actor?.name ?? null,
    target: row.target,
    data:
      typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    createdAt: row.createdAt.toISOString(),
  }));
  return ActivityListResponseSchema.parse({ entries });
}
