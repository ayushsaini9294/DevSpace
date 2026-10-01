import { createHash, randomBytes } from 'node:crypto';
import {
  AiPreferencesSchema,
  type AiAssistantReason,
  type AiAssistantStatus,
  type AiPreferences,
} from '@devspace/shared';
import { prisma } from '../lib/prisma.ts';
import { readSettings, type Db } from '../projects/access.ts';

/**
 * The IDE's built-in AI assistant (Phase 12): per-copy gateway tokens, whether the assistant can
 * answer for a copy's owner, the owner's paid-model preference and daily usage counts.
 */

/** A new gateway token: 32 random bytes, base64url (43 characters). */
export function newAiGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAiGatewayToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Stores (only the hash of) the token now given to the copy's container, replacing the old one,
 * so an old container's token stops working. Any other copy holding the same hash (impossible in
 * practice) loses it first, keeping the column unique.
 */
export async function setAiGatewayToken(copyId: string, token: string, db: Db = prisma) {
  const hash = hashAiGatewayToken(token);
  await db.copy.updateMany({
    where: { aiGatewayTokenHash: hash, NOT: { id: copyId } },
    data: { aiGatewayTokenHash: null },
  });
  await db.copy.updateMany({ where: { id: copyId }, data: { aiGatewayTokenHash: hash } });
}

/**
 * Why the owner can't use the assistant in this project right now, or null when they can:
 * the project's AI switch, then an OpenRouter connection, then the accepted AI notice.
 */
export async function aiAssistantBlocker(
  projectId: string,
  ownerId: string,
  db: Db = prisma,
): Promise<AiAssistantReason | null> {
  const [project, user] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { settings: true } }),
    db.user.findUnique({
      where: { id: ownerId },
      select: { aiNoticeAcceptedAt: true, aiConnection: { select: { id: true } } },
    }),
  ]);
  if (!project || !readSettings(project.settings).aiReviewEnabled) return 'ai_disabled';
  if (!user?.aiConnection) return 'not_connected';
  if (!user.aiNoticeAcceptedAt) return 'notice_required';
  return null;
}

/** `CopyView.aiAssistant` for a copy of `ownerId` in `projectId`. */
export async function aiAssistantStatus(
  projectId: string,
  ownerId: string,
  db: Db = prisma,
): Promise<AiAssistantStatus> {
  const reason = await aiAssistantBlocker(projectId, ownerId, db);
  return { ready: reason === null, reason };
}

/** Today's date in UTC, `YYYY-MM-DD`. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Counts one assistant request (never any of its text). Errors are logged, never thrown. */
export async function countAiGatewayRequest(userId: string, model: string): Promise<void> {
  try {
    const day = utcDay();
    await prisma.$executeRaw`
      INSERT INTO ai_gateway_usage (user_id, day, model, requests)
      VALUES (${userId}, ${day}::date, ${model}, 1)
      ON CONFLICT (user_id, day, model)
      DO UPDATE SET requests = ai_gateway_usage.requests + 1`;
  } catch (err) {
    console.error(
      'Could not count an AI assistant request:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
}

/** GET/PATCH /api/ai/preferences. */
export async function aiPreferences(userId: string): Promise<AiPreferences> {
  const day = utcDay();
  const [user, rows] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { aiAllowPaid: true } }),
    prisma.aiGatewayUsage.findMany({
      where: { userId, day: new Date(`${day}T00:00:00.000Z`) },
      select: { model: true, requests: true },
    }),
  ]);
  const models = rows
    .filter((r) => r.requests > 0)
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  return AiPreferencesSchema.parse({
    allowPaid: user.aiAllowPaid,
    assistantUsageToday: {
      day,
      requests: models.reduce((sum, r) => sum + r.requests, 0),
      models,
    },
  });
}

export async function setAiAllowPaid(userId: string, allowPaid: boolean): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { aiAllowPaid: allowPaid } });
}
