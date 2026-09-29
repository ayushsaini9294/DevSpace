import { createHash, randomBytes } from 'node:crypto';
import {
  AiConnectionViewSchema,
  type AiConnectionView,
  type AiModel,
  type FreeRequests,
} from '@devspace/shared';
import { env } from '../config/env.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import {
  authUrl,
  exchangeCode,
  fetchModels,
  freeRequestsToday,
  OpenRouterError,
} from './openrouter.ts';

/**
 * Connecting a member's OpenRouter account (Phase 10): OAuth with PKCE. The verifier and state
 * stay on the server (the state only as a hash, the verifier encrypted), bound to the user's
 * session, single use, for 10 minutes. The key is stored encrypted and never leaves the server.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const KEY_INFO_TTL_MS = 60_000;
const MODELS_TTL_MS = 10 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const invalidState = () =>
  new HttpError(
    400,
    'invalid_state',
    'This sign-in link expired or was already used; connect again',
  );

export function openRouterError(err: unknown, action: string): HttpError {
  const message =
    err instanceof OpenRouterError && err.kind === 'http' && err.providerMessage
      ? `${action}: ${err.providerMessage}`
      : err instanceof OpenRouterError
        ? `${action}: ${err.message}`
        : `${action}: OpenRouter didn't answer`;
  return new HttpError(502, 'openrouter_error', message);
}

/** POST /api/ai/openrouter/start → the OpenRouter login URL. */
export async function startConnect(userId: string, sessionId: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const now = Date.now();
  await prisma.aiOAuthState.deleteMany({
    where: { OR: [{ expiresAt: { lte: new Date(now) } }, { userId, sessionId }] },
  });
  await prisma.aiOAuthState.create({
    data: {
      id: sha256(state),
      userId,
      sessionId,
      encryptedVerifier: encryptSecret(verifier),
      expiresAt: new Date(now + OAUTH_STATE_TTL_MS),
    },
  });
  const callback = `${env.APP_ORIGIN}/settings/ai/callback?state=${encodeURIComponent(state)}`;
  return authUrl(callback, challenge);
}

/** POST /api/ai/openrouter/finish: checks and uses up the state, then stores the key. */
export async function finishConnect(
  userId: string,
  sessionId: string,
  code: string,
  state: string,
): Promise<void> {
  const id = sha256(state);
  const row = await prisma.aiOAuthState.findUnique({ where: { id } });
  if (!row || row.userId !== userId || row.sessionId !== sessionId) throw invalidState();
  // Single use: whoever deletes it first goes on.
  const { count } = await prisma.aiOAuthState.deleteMany({ where: { id, userId, sessionId } });
  if (count === 0 || row.expiresAt.getTime() <= Date.now()) throw invalidState();
  let key: string;
  try {
    key = await exchangeCode(code, decryptSecret(row.encryptedVerifier));
  } catch (err) {
    throw openRouterError(err, 'OpenRouter refused the sign-in');
  }
  const data = {
    encryptedKey: encryptSecret(key),
    keyHint: key.slice(-4),
    connectedAt: new Date(),
  };
  await prisma.aiConnection.upsert({
    where: { userId },
    create: { userId, provider: 'openrouter', ...data },
    update: data,
  });
  keyInfoCache.delete(userId);
}

export async function disconnect(userId: string): Promise<void> {
  await prisma.aiConnection.deleteMany({ where: { userId } });
  keyInfoCache.delete(userId);
}

/** The user's decrypted key, or null when not connected. Never log or return it. */
export async function userKey(userId: string): Promise<string | null> {
  const row = await prisma.aiConnection.findUnique({
    where: { userId },
    select: { encryptedKey: true },
  });
  return row ? decryptSecret(row.encryptedKey) : null;
}

const keyInfoCache = new Map<string, { at: number; value: FreeRequests | null }>();

/** Today's free requests for the user's key (cached 60 s; null when OpenRouter can't say). */
async function cachedFreeRequests(userId: string, key: string): Promise<FreeRequests | null> {
  const hit = keyInfoCache.get(userId);
  if (hit && Date.now() - hit.at < KEY_INFO_TTL_MS) return hit.value;
  let value: FreeRequests | null = null;
  try {
    value = await freeRequestsToday(key);
  } catch (err) {
    console.error(
      'Could not read OpenRouter key usage:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
  keyInfoCache.set(userId, { at: Date.now(), value });
  return value;
}

export async function connectionView(userId: string): Promise<AiConnectionView> {
  const [user, row] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { aiNoticeAcceptedAt: true } }),
    prisma.aiConnection.findUnique({ where: { userId } }),
  ]);
  let freeRequests: FreeRequests | null = null;
  if (row) {
    try {
      freeRequests = await cachedFreeRequests(userId, decryptSecret(row.encryptedKey));
    } catch (err) {
      console.error('Could not read a stored AI key:', err instanceof Error ? err.message : err);
    }
  }
  return AiConnectionViewSchema.parse({
    connected: row !== null,
    provider: 'openrouter',
    keyHint: row?.keyHint ?? null,
    connectedAt: row?.connectedAt.toISOString() ?? null,
    freeRequestsToday: freeRequests,
    noticeAcceptedAt: user?.aiNoticeAcceptedAt?.toISOString() ?? null,
  });
}

/** POST /api/ai/notice/accept: kept from the first time. */
export async function acceptNotice(userId: string): Promise<Date> {
  await prisma.user.updateMany({
    where: { id: userId, aiNoticeAcceptedAt: null },
    data: { aiNoticeAcceptedAt: new Date() },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { aiNoticeAcceptedAt: true },
  });
  return user.aiNoticeAcceptedAt!;
}

let modelsCache: { at: number; models: AiModel[] } | null = null;

/** OpenRouter's models (cached 10 min). Throws 502 `openrouter_error` if it can't be reached. */
export async function listModels(): Promise<AiModel[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  let models: AiModel[];
  try {
    models = await fetchModels();
  } catch (err) {
    throw openRouterError(err, 'Could not load the model list');
  }
  models.sort((a, b) =>
    a.isFree !== b.isFree ? (a.isFree ? -1 : 1) : a.name.localeCompare(b.name),
  );
  modelsCache = { at: Date.now(), models };
  return models;
}

/** Tests: forget cached answers. */
export function clearAiCaches(): void {
  modelsCache = null;
  keyInfoCache.clear();
}
