import { Router } from 'express';
import { CopyResponseSchema } from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { requireProjectAction } from '../projects/access.ts';
import { openIde } from '../ide/service.ts';
import { ensureCopy, findCopy } from './service.ts';

/**
 * Mounted at /api/projects/:projectId (after requireAuth). Every member reaches only their own
 * copy: the user always comes from the session, never from the request.
 */
export const copyRouter = Router({ mergeParams: true });

copyRouter.get('/copy', async (req, res) => {
  const access = await requireProjectAction(req);
  const copy = await findCopy(access.project.id, access.userId);
  res.json(CopyResponseSchema.parse({ copy }));
});

copyRouter.post('/copy', async (req, res) => {
  const access = await requireProjectAction(req);
  const user = req.user as AuthUser;
  const { copy, created } = await ensureCopy(access.project.id, user);
  res.status(created ? 201 : 200).json(CopyResponseSchema.parse({ copy }));
});

/**
 * Makes the caller's copy if needed, then starts (or reuses) its IDE container. Answers right
 * away: `starting` until the IDE answers (the page polls GET /copy), or `running`.
 */
copyRouter.post('/copy/ide', async (req, res) => {
  const access = await requireProjectAction(req);
  const user = req.user as AuthUser;
  const copy = await openIde(access.project.id, user);
  res.json(CopyResponseSchema.parse({ copy }));
});
