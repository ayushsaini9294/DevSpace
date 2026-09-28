import {
  MAX_NOTIFICATION_PATHS,
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATIONS_PAGE_SIZE,
  NotificationDataSchemas,
  NotificationViewSchema,
  can,
  type NotificationData,
  type NotificationType,
  type NotificationView,
} from '@devspace/shared';
import type { Prisma } from '../generated/prisma/client.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { afterCommit } from '../lib/transaction.ts';
import { readPermissions, type Db } from '../projects/access.ts';
import { sendNotification } from '../realtime/emitter.ts';

/**
 * In-app notifications (Phase 9). `notify` writes the rows with the change they describe (pass
 * the transaction) and pushes them to their users' sockets after the commit. The person who
 * did it (`actorId`) never gets one.
 */

export interface NotifyInput<T extends NotificationType> {
  type: T;
  projectId: string | null;
  userIds: Iterable<string>;
  /** Who did it (never notified); null for automatic changes. */
  actorId: string | null;
  data: NotificationData<T>;
}

const viewSelect = {
  id: true,
  type: true,
  data: true,
  readAt: true,
  createdAt: true,
  project: { select: { id: true, name: true } },
} as const;

type ViewRow = Prisma.NotificationGetPayload<{ select: typeof viewSelect }>;

/** The browser's view of a row, or null if the row doesn't match its type's schema. */
function toView(row: ViewRow): NotificationView | null {
  const result = NotificationViewSchema.safeParse({
    id: row.id,
    type: row.type,
    project: row.project,
    data: row.data,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
  if (!result.success) {
    console.error(`Notification ${row.id} (${row.type}) doesn't match its schema; not shown`);
    return null;
  }
  return result.data;
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Creates one notification per recipient (minus the actor) and pushes them after commit. */
export async function notify<T extends NotificationType>(
  db: Db,
  input: NotifyInput<T>,
): Promise<number> {
  const recipients = [...new Set(input.userIds)].filter((id) => id !== input.actorId);
  if (recipients.length === 0) return 0;
  const data = NotificationDataSchemas[input.type].parse(input.data) as Prisma.InputJsonObject;
  const rows = await db.notification.createManyAndReturn({
    data: recipients.map((userId) => ({
      userId,
      projectId: input.projectId,
      type: input.type,
      data,
    })),
    select: { id: true, userId: true },
  });
  await afterCommit(db, async () => {
    const full = await prisma.notification.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { ...viewSelect, userId: true },
    });
    for (const row of full) {
      const view = toView(row);
      if (!view) continue;
      sendNotification(row.userId, {
        notification: view,
        unreadCount: await unreadCount(row.userId),
      });
    }
  });
  return rows.length;
}

/** Caps a path list for notification data. */
export function pathsData(paths: readonly string[]): { paths: string[]; morePaths: number } {
  return {
    paths: paths.slice(0, MAX_NOTIFICATION_PATHS),
    morePaths: Math.max(0, paths.length - MAX_NOTIFICATION_PATHS),
  };
}

// ---------- Recipients ----------

/** Leaders and co-leaders of the project. */
export async function projectLeads(db: Db, projectId: string): Promise<string[]> {
  const rows = await db.projectMember.findMany({
    where: { projectId, role: { in: ['leader', 'co_leader'] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Everyone who may approve: leaders, co-leaders and members with the Approve permission. */
export async function projectApprovers(db: Db, projectId: string): Promise<string[]> {
  const rows = await db.projectMember.findMany({
    where: { projectId },
    select: { userId: true, role: true, permissions: true },
  });
  return rows
    .filter((r) => can(r.role, readPermissions(r.permissions), 'submission.approve'))
    .map((r) => r.userId);
}

/** A user's name (for `actorName`), or null. */
export async function nameOf(db: Db, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  return row?.name ?? null;
}

// ---------- Reading ----------

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const bad = () =>
    new HttpError(400, 'validation_error', 'Some fields are invalid', {
      cursor: ['Invalid cursor'],
    });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  ) {
    throw bad();
  }
  const createdAt = new Date(value[0]);
  if (Number.isNaN(createdAt.getTime())) throw bad();
  return { createdAt, id: value[1] };
}

/** One page of the user's own notifications, newest first. */
export async function listNotifications(userId: string, cursor?: string) {
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = await prisma.notification.findMany({
    where: {
      userId,
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: NOTIFICATIONS_PAGE_SIZE + 1,
    select: viewSelect,
  });
  const page = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    notifications: page.map(toView).filter((v): v is NotificationView => v !== null),
    unreadCount: await unreadCount(userId),
    nextCursor: rows.length > NOTIFICATIONS_PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}

/** Marks some (only the user's own) or all as read; returns the new unread count. */
export async function markRead(userId: string, which: { ids: string[] } | { all: true }) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null, ...('ids' in which ? { id: { in: which.ids } } : {}) },
    data: { readAt: new Date() },
  });
  return unreadCount(userId);
}

// ---------- Cleanup ----------

/** Deletes notifications older than 30 days (the worker runs it). Returns how many. */
export async function deleteOldNotifications(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
