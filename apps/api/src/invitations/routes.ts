import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import {
  AcceptInvitationResponseSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  DEFAULT_MEMBER_PERMISSIONS,
  INVITATION_TTL_DAYS,
  InvitationListResponseSchema,
  InvitationPreviewResponseSchema,
  type Invitation,
} from '@devspace/shared';
import { Prisma } from '../generated/prisma/client.ts';
import type { AuthUser } from '../auth/session.ts';
import { prisma } from '../lib/prisma.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { recordActivity } from '../activity/log.ts';
import { requireProjectAction } from '../projects/access.ts';
import { transaction } from '../lib/transaction.ts';
import { notify, projectLeads } from '../notifications/service.ts';

const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Invitation links carry a random token; only its SHA-256 hex hash is stored. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const invitationNotFound = () => new HttpError(404, 'not_found', 'Invitation not found');
const invitationExpired = () =>
  new HttpError(410, 'invitation_expired', 'This invitation has expired; ask for a new link');
const invitationUsed = () =>
  new HttpError(409, 'invitation_used', 'This invitation has already been used');
const alreadyMember = () =>
  new HttpError(409, 'already_member', 'This person is already a member of the project');

function toInvitation(row: {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { name: string };
}): Invitation {
  return {
    id: row.id,
    email: row.email,
    invitedByName: row.invitedBy.name,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const invitationSelect = {
  id: true,
  email: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { name: true } },
} as const;

// ---------- /api/projects/:projectId/invitations (members.invite) ----------

export const projectInvitationsRouter = Router({ mergeParams: true });

projectInvitationsRouter.post('/', async (req, res) => {
  const access = await requireProjectAction(req, 'members.invite');
  const { email } = parseBody(CreateInvitationRequestSchema, req.body);
  const projectId = access.project.id;

  const isMember = await prisma.projectMember.count({
    where: { projectId, user: { email } },
  });
  if (isMember > 0) throw alreadyMember();

  const token = randomBytes(32).toString('base64url');
  const invitation = await transaction(async (tx) => {
    // Re-inviting replaces the old link.
    await tx.invitation.updateMany({
      where: { projectId, email, status: 'pending' },
      data: { status: 'revoked' },
    });
    const created = await tx.invitation.create({
      data: {
        projectId,
        email,
        tokenHash: hashInvitationToken(token),
        invitedById: access.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: invitationSelect,
    });
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'member.invited',
      target: email,
      data: { invitationId: created.id },
    });
    return created;
  });

  res.set('Cache-Control', 'no-store');
  res.status(201).json(
    CreateInvitationResponseSchema.parse({
      invitation: toInvitation(invitation),
      path: `/invite/${token}`,
    }),
  );
});

projectInvitationsRouter.get('/', async (req, res) => {
  const access = await requireProjectAction(req, 'members.invite');
  const rows = await prisma.invitation.findMany({
    where: { projectId: access.project.id, status: 'pending', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: invitationSelect,
  });
  res.json(InvitationListResponseSchema.parse({ invitations: rows.map(toInvitation) }));
});

projectInvitationsRouter.delete('/:invitationId', async (req, res) => {
  const access = await requireProjectAction(req, 'members.invite');
  const projectId = access.project.id;
  await transaction(async (tx) => {
    const invitation = await tx.invitation.findFirst({
      where: { id: req.params.invitationId, projectId, status: 'pending' },
      select: { id: true, email: true },
    });
    if (!invitation) throw invitationNotFound();
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'revoked' },
    });
    if (count !== 1) throw invitationNotFound();
    await recordActivity(tx, {
      projectId,
      actorId: access.userId,
      action: 'invitation.cancelled',
      target: invitation.email,
      data: { invitationId: invitation.id },
    });
  });
  res.status(204).end();
});

// ---------- /api/invitations/:token (the invited person) ----------

/** Mounted at /api/invitations behind requireAuth. */
export const invitationsRouter = Router();

/** Finds a usable invitation by its token: 404 unknown/cancelled, 409 used, 410 expired. */
async function findUsableInvitation(token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      id: true,
      projectId: true,
      email: true,
      status: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
      project: { select: { name: true, teamId: true, team: { select: { name: true } } } },
    },
  });
  if (!invitation || invitation.status === 'revoked') throw invitationNotFound();
  if (invitation.status === 'accepted') throw invitationUsed();
  if (invitation.expiresAt.getTime() <= Date.now()) throw invitationExpired();
  return invitation;
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

invitationsRouter.get('/:token', async (req, res) => {
  const user = req.user as AuthUser;
  const invitation = await findUsableInvitation(req.params.token);
  res.set('Cache-Control', 'no-store');
  res.json(
    InvitationPreviewResponseSchema.parse({
      projectName: invitation.project.name,
      teamName: invitation.project.team.name,
      invitedByName: invitation.invitedBy.name,
      email: invitation.email,
      expiresAt: invitation.expiresAt.toISOString(),
      matchesYou: sameEmail(invitation.email, user.email),
    }),
  );
});

invitationsRouter.post('/:token/accept', async (req, res) => {
  const user = req.user as AuthUser;
  const invitation = await findUsableInvitation(req.params.token);
  if (!sameEmail(invitation.email, user.email)) {
    throw new HttpError(
      403,
      'wrong_account',
      `This invitation is for ${invitation.email}; log in with that email to accept it`,
    );
  }
  const { projectId } = invitation;

  try {
    await transaction(async (tx) => {
      const existing = await tx.projectMember.count({ where: { projectId, userId: user.id } });
      if (existing > 0) throw alreadyMember();
      // Conditional on status and expiry, so two accepts of the same link can't both succeed.
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, status: 'pending', expiresAt: { gt: new Date() } },
        data: { status: 'accepted', acceptedAt: new Date(), acceptedById: user.id },
      });
      if (count !== 1) throw invitationUsed();
      await tx.projectMember.create({
        data: {
          projectId,
          userId: user.id,
          role: 'member',
          permissions: DEFAULT_MEMBER_PERMISSIONS,
        },
      });
      await tx.teamMember.createMany({
        data: [{ teamId: invitation.project.teamId, userId: user.id }],
        skipDuplicates: true,
      });
      await recordActivity(tx, {
        projectId,
        actorId: user.id,
        action: 'member.joined',
        target: user.id,
        data: { name: user.name, email: user.email, invitationId: invitation.id },
      });
      await notify(tx, {
        type: 'invitation.accepted',
        projectId,
        userIds: await projectLeads(tx, projectId),
        actorId: user.id,
        data: { userId: user.id, userName: user.name },
      });
    });
  } catch (err) {
    // A concurrent accept by the same user (different link) inserted the member first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw alreadyMember();
    }
    throw err;
  }

  res.json(AcceptInvitationResponseSchema.parse({ projectId }));
});
