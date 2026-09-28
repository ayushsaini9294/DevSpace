import { Router } from 'express';
import {
  MarkNotificationsReadRequestSchema,
  MarkNotificationsReadResponseSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  PreferencesSchema,
  UpdatePreferencesRequestSchema,
} from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { prisma } from '../lib/prisma.ts';
import { parseBody } from '../lib/validate.ts';
import { hideOpenFile } from '../realtime/presence.ts';
import { listNotifications, markRead } from './service.ts';

/** Mounted at /api/notifications behind requireAuth: only ever the caller's own. */
export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const { cursor } = parseBody(NotificationListQuerySchema, req.query);
  res.json(NotificationListResponseSchema.parse(await listNotifications(user.id, cursor)));
});

notificationsRouter.post('/read', async (req, res) => {
  const user = req.user as AuthUser;
  const which = parseBody(MarkNotificationsReadRequestSchema, req.body);
  res.json(
    MarkNotificationsReadResponseSchema.parse({ unreadCount: await markRead(user.id, which) }),
  );
});

/** Mounted at /api/me behind requireAuth. */
export const meRouter = Router();

meRouter.get('/preferences', async (req, res) => {
  const user = req.user as AuthUser;
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { shareOpenFile: true },
  });
  res.json(PreferencesSchema.parse(row));
});

meRouter.patch('/preferences', async (req, res) => {
  const user = req.user as AuthUser;
  const { shareOpenFile } = parseBody(UpdatePreferencesRequestSchema, req.body);
  const row = await prisma.user.update({
    where: { id: user.id },
    data: { shareOpenFile },
    select: { shareOpenFile: true },
  });
  if (!shareOpenFile) {
    await hideOpenFile(user.id).catch((err: unknown) =>
      console.error('Could not hide the open file:', err instanceof Error ? err.message : err),
    );
  }
  res.json(PreferencesSchema.parse(row));
});
