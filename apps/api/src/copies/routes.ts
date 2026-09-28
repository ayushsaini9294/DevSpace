import { Router, type Request } from 'express';
import {
  CopyResponseSchema,
  CopyUpdatePreviewSchema,
  CopyUpdateResponseSchema,
  IdeLaunchResponseSchema,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import type { AuthUser } from '../auth/session.ts';
import { requireProjectAction, type ProjectAccess } from '../projects/access.ts';
import { createLaunchUrl } from '../ide/access.ts';
import { openIde, startCopyIde } from '../ide/service.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { invalidateAfterCommit } from '../realtime/emitter.ts';
import { nameOf, notify } from '../notifications/service.ts';
import { transaction } from '../lib/transaction.ts';
import { ensureCopy, findCopy } from './service.ts';
import { previewMyUpdate, updateMyCopy } from './update.ts';

/**
 * Mounted at /api/projects/:projectId (after requireAuth). Under /copy every member reaches only
 * their own copy: the user always comes from the session, never from the request. Under
 * /members/:userId/copy a leader or co-leader (`copy.helpFixConflict`) reaches that member's
 * copy (Phase 7), and nothing else.
 */
export const copyRouter = Router({ mergeParams: true });

const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");

function gitDirOf(access: ProjectAccess): string {
  if (!access.project.repoPath) throw notReady();
  return access.project.repoPath;
}

const ideNotRunning = () =>
  new HttpError(409, 'ide_not_running', "The IDE isn't running; open it first");

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

/**
 * A one-time link that opens the caller's running IDE on the IDE site (see ide/access.ts).
 * 404 when the caller has no copy; 409 `ide_not_running` unless its container is running.
 */
copyRouter.post('/copy/ide/launch', async (req, res) => {
  const access = await requireProjectAction(req);
  const copy = await prisma.copy.findUnique({
    where: { projectId_userId: { projectId: access.project.id, userId: access.userId } },
    select: { id: true, containerStatus: true },
  });
  if (!copy) throw new HttpError(404, 'not_found', 'You have no copy of this project yet');
  if (copy.containerStatus !== 'running') throw ideNotRunning();
  const url = await createLaunchUrl(access.userId, copy.id);
  res.json(IdeLaunchResponseSchema.parse({ url }));
});

// ---------- Updating my copy to the new main (Phase 7) ----------

copyRouter.get('/copy/update', async (req, res) => {
  const access = await requireProjectAction(req);
  const preview = await previewMyUpdate(gitDirOf(access), access.project.id, access.userId);
  res.json(CopyUpdatePreviewSchema.parse(preview));
});

copyRouter.post('/copy/update', async (req, res) => {
  const access = await requireProjectAction(req);
  const { conflictPaths } = await updateMyCopy(gitDirOf(access), access.project.id, access.userId);
  const copy = await findCopy(access.project.id, access.userId);
  res.json(CopyUpdateResponseSchema.parse({ copy, conflictPaths }));
});

// ---------- The npm reminder (Phase 9) ----------

/** Clears `packagesChanged` on the caller's copy. */
copyRouter.post('/copy/packages-dismiss', async (req, res) => {
  const access = await requireProjectAction(req);
  const { count } = await prisma.copy.updateMany({
    where: { projectId: access.project.id, userId: access.userId },
    data: { packagesChangedAt: null },
  });
  if (count === 0) {
    throw new HttpError(
      409,
      'no_copy',
      "You don't have a copy of this project yet; open the IDE first",
    );
  }
  await invalidateAfterCommit(prisma, access.project.id, [`copy:${access.userId}`]);
  res.json(CopyResponseSchema.parse({ copy: await findCopy(access.project.id, access.userId) }));
});

// ---------- A lead opens a member's copy (Phase 7) ----------

/**
 * The member's copy for a lead: `copy.helpFixConflict` (403 otherwise; 404 for non-members of
 * the project), and the member must be in the project and have a copy (404 otherwise).
 */
async function memberCopy(req: Request) {
  const access = await requireProjectAction(req, 'copy.helpFixConflict');
  const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
  const owner = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: access.project.id, userId } },
    select: { user: { select: { id: true, name: true } } },
  });
  const copy = owner
    ? await prisma.copy.findUnique({
        where: { projectId_userId: { projectId: access.project.id, userId } },
        select: { id: true, containerStatus: true },
      })
    : null;
  if (!owner || !copy) throw new HttpError(404, 'not_found', 'That member has no copy yet');
  return { access, owner: owner.user, copy };
}

copyRouter.get('/members/:userId/copy', async (req, res) => {
  const { access, owner } = await memberCopy(req);
  res.json(CopyResponseSchema.parse({ copy: await findCopy(access.project.id, owner.id) }));
});

copyRouter.post('/members/:userId/copy/ide', async (req, res) => {
  const { access, copy } = await memberCopy(req);
  res.json(CopyResponseSchema.parse({ copy: await startCopyIde(copy.id, access.project.id) }));
});

/** A one-time link for the calling lead into the member's running IDE; logged as `copy.helped`. */
copyRouter.post('/members/:userId/copy/ide/launch', async (req, res) => {
  const { access, owner, copy } = await memberCopy(req);
  if (copy.containerStatus !== 'running') throw ideNotRunning();
  const url = await createLaunchUrl(access.userId, copy.id);
  if (owner.id !== access.userId) {
    await transaction(async (tx) => {
      await recordActivity(tx, {
        projectId: access.project.id,
        actorId: access.userId,
        action: 'copy.helped',
        target: owner.id,
        data: { ownerName: owner.name },
      });
      await notify(tx, {
        type: 'copy.helped',
        projectId: access.project.id,
        userIds: [owner.id],
        actorId: access.userId,
        data: { actorName: await nameOf(tx, access.userId) },
      });
    });
  }
  res.json(IdeLaunchResponseSchema.parse({ url }));
});
