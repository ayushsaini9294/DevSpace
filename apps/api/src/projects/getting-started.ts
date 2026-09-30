import { Router } from 'express';
import {
  GettingStartedViewSchema,
  type GettingStartedStepId,
  type GettingStartedView,
} from '@devspace/shared';
import { copyBaseSha, copyDir } from '../copies/service.ts';
import { prisma } from '../lib/prisma.ts';
import { diffCopy } from '../submissions/scan.ts';
import { requireProjectAction, type ProjectAccess } from './access.ts';

/**
 * The getting-started checklist (Phase 11). Every step is worked out from real data each time
 * it is asked for; nothing is ticked by hand. Only hiding the card is stored
 * (`ProjectMember.gettingStartedHiddenAt`).
 */

/** Does the member's copy differ from its base right now? Unreadable or too big → false. */
async function copyHasChanges(
  projectId: string,
  repoPath: string | null,
  copy: { id: string; baseSha: string | null },
): Promise<boolean> {
  if (!repoPath) return false;
  try {
    const baseSha = await copyBaseSha(copy, repoPath);
    const changes = await diffCopy(repoPath, baseSha, copyDir(projectId, copy.id));
    return changes.size > 0;
  } catch {
    return false;
  }
}

export async function gettingStarted(access: ProjectAccess): Promise<GettingStartedView> {
  const projectId = access.project.id;
  const userId = access.userId;
  const isLead = access.role === 'leader' || access.role === 'co_leader';
  const now = new Date();

  const [project, member, copy, submissionCount, reviewedCount] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { repoStatus: true, repoPath: true },
    }),
    prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId } },
      select: { previewedAt: true, gettingStartedHiddenAt: true },
    }),
    prisma.copy.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true, baseSha: true, containerStatus: true },
    }),
    prisma.submission.count({ where: { projectId, authorId: userId } }),
    prisma.submission.count({
      where: {
        projectId,
        authorId: userId,
        OR: [
          { mergedSha: { not: null } },
          { reviews: { some: { reviewerId: { not: userId } } } },
          { comments: { some: { authorId: { not: userId } } } },
        ],
      },
    }),
  ]);

  const done: Partial<Record<GettingStartedStepId, boolean>> = {};
  if (isLead) {
    done.setup = project.repoStatus === 'ready';
    const [others, pending] = await Promise.all([
      prisma.projectMember.count({ where: { projectId, userId: { not: userId } } }),
      prisma.invitation.count({
        where: { projectId, status: 'pending', expiresAt: { gt: now } },
      }),
    ]);
    done.invite = others > 0 || pending > 0;
  }
  done.openIde = copy !== null && copy.containerStatus !== 'none';
  done.submit = submissionCount > 0;
  done.change =
    done.submit ||
    (copy !== null &&
      project.repoStatus === 'ready' &&
      (await copyHasChanges(projectId, project.repoPath, copy)));
  done.preview = member.previewedAt !== null;
  done.reviewed = reviewedCount > 0;

  const order: GettingStartedStepId[] = isLead
    ? ['setup', 'invite', 'openIde', 'change', 'preview', 'submit', 'reviewed']
    : ['openIde', 'change', 'preview', 'submit', 'reviewed'];
  return GettingStartedViewSchema.parse({
    hidden: member.gettingStartedHiddenAt !== null,
    steps: order.map((id) => ({ id, done: done[id] ?? false })),
  });
}

/** Mounted at /api/projects/:projectId (after requireAuth). Any member, for themselves only. */
export const gettingStartedRouter = Router({ mergeParams: true });

gettingStartedRouter.get('/getting-started', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await gettingStarted(access));
});

async function setHidden(access: ProjectAccess, hidden: boolean) {
  await prisma.projectMember.updateMany({
    where: { projectId: access.project.id, userId: access.userId },
    data: { gettingStartedHiddenAt: hidden ? new Date() : null },
  });
  return gettingStarted(access);
}

gettingStartedRouter.post('/getting-started/hide', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await setHidden(access, true));
});

gettingStartedRouter.post('/getting-started/show', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await setHidden(access, false));
});
