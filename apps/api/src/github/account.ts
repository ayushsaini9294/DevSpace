import { createHash, randomBytes } from 'node:crypto';
import { GithubAccountViewSchema, type GithubAccountView } from '@devspace/shared';
import { env } from '../config/env.ts';
import { decryptSecret, encryptSecret } from '../ai/crypto.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { transaction } from '../lib/transaction.ts';
import {
  authorizeUrl,
  exchangeCode,
  GithubApiError,
  isUser,
  listAll,
  refreshTokens,
  rest,
  type GhInstallation,
  type UserTokens,
} from './api.ts';
import { githubConfig, installUrlOf, requireGithubConfig, type GithubConfig } from './config.ts';

/**
 * Connecting a member's GitHub account (Phase 13): the DevSpace app's user authorization, with
 * PKCE. The state is bound to the session, single use, 10 minutes (kept only as a hash, the
 * verifier encrypted). Tokens are stored encrypted (Phase 10 crypto) and refreshed when they
 * expire; they never leave the server.
 */

export const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh an access token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const invalidGithubState = () =>
  new HttpError(
    400,
    'invalid_state',
    'This GitHub sign-in link expired or was already used; connect again',
  );

export const notConnected = (message = 'Connect your GitHub account first (Settings → GitHub)') =>
  new HttpError(409, 'github_not_connected', message);

/** A GitHub failure as a 502 `github_error` (or 403 for a missing app permission). */
export function githubError(err: unknown, action: string): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof GithubApiError) {
    if (err.kind === 'http' && err.status === 403) {
      return new HttpError(
        403,
        'github_permission_denied',
        `${action}: GitHub refused (${err.providerMessage || 'forbidden'}). Check that the DevSpace app is installed on your account and has the permissions it asks for.`,
      );
    }
    const why = err.kind === 'http' && err.providerMessage ? err.providerMessage : err.message;
    return new HttpError(502, 'github_error', `${action}: ${why}`);
  }
  return new HttpError(502, 'github_error', `${action}: GitHub didn't answer`);
}

export function callbackUrl(): string {
  return `${env.APP_ORIGIN}/settings/github/callback`;
}

/** POST /api/github/connect/start → GitHub's authorize URL. */
export async function startGithubConnect(userId: string, sessionId: string): Promise<string> {
  const c = requireGithubConfig();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const now = Date.now();
  await prisma.githubOAuthState.deleteMany({
    where: { OR: [{ expiresAt: { lte: new Date(now) } }, { userId, sessionId }] },
  });
  await prisma.githubOAuthState.create({
    data: {
      id: sha256(state),
      userId,
      sessionId,
      encryptedVerifier: encryptSecret(verifier),
      expiresAt: new Date(now + GITHUB_STATE_TTL_MS),
    },
  });
  return authorizeUrl(c, callbackUrl(), state, challenge);
}

function tokenData(tokens: UserTokens) {
  return {
    encryptedAccessToken: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    encryptedRefreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    refreshTokenExpiresAt: tokens.refreshToken ? tokens.refreshTokenExpiresAt : null,
  };
}

/** POST /api/github/connect/finish: checks and uses up the state, then stores the tokens. */
export async function finishGithubConnect(
  userId: string,
  sessionId: string,
  code: string,
  state: string,
): Promise<void> {
  const c = requireGithubConfig();
  const id = sha256(state);
  const row = await prisma.githubOAuthState.findUnique({ where: { id } });
  if (!row || row.userId !== userId || row.sessionId !== sessionId) throw invalidGithubState();
  const { count } = await prisma.githubOAuthState.deleteMany({ where: { id, userId, sessionId } });
  if (count === 0 || row.expiresAt.getTime() <= Date.now()) throw invalidGithubState();
  let tokens: UserTokens;
  let user: { id: number; login: string };
  try {
    tokens = await exchangeCode(c, code, decryptSecret(row.encryptedVerifier), callbackUrl());
    const { data } = await rest(c, 'GET', '/user', tokens.accessToken);
    if (!isUser(data)) throw new GithubApiError('bad_response', null, '');
    user = data;
  } catch (err) {
    throw githubError(err, 'GitHub refused the sign-in');
  }
  const data = {
    githubUserId: BigInt(user.id),
    login: user.login,
    connectedAt: new Date(),
    ...tokenData(tokens),
  };
  await prisma.githubAccount.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function disconnectGithub(userId: string): Promise<void> {
  await prisma.githubAccount.deleteMany({ where: { userId } });
}

/**
 * A working user access token for `userId`, refreshed when it is about to expire (one refresh
 * at a time per user, since GitHub's refresh tokens are single use). 409 `github_not_connected`
 * when there is none or GitHub no longer accepts it (the stored tokens are then deleted).
 */
export async function userAccessToken(
  c: GithubConfig,
  userId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const row = await prisma.githubAccount.findUnique({ where: { userId } });
  if (!row) throw notConnected();
  const fresh = (r: typeof row) =>
    !r.accessTokenExpiresAt || r.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
  if (!options.forceRefresh && fresh(row)) return decryptSecret(row.encryptedAccessToken);

  const outcome = await transaction(async (tx): Promise<{ token: string } | { expired: true }> => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('devspace.github-user'), hashtext(${userId}))`;
    const current = await tx.githubAccount.findUnique({ where: { userId } });
    if (!current) throw notConnected();
    // Someone else refreshed it while we waited.
    if (current.updatedAt.getTime() > row.updatedAt.getTime() && fresh(current)) {
      return { token: decryptSecret(current.encryptedAccessToken) };
    }
    if (!options.forceRefresh && fresh(current)) {
      return { token: decryptSecret(current.encryptedAccessToken) };
    }
    if (
      !current.encryptedRefreshToken ||
      (current.refreshTokenExpiresAt && current.refreshTokenExpiresAt.getTime() <= Date.now())
    ) {
      return { expired: true };
    }
    let tokens: UserTokens;
    try {
      tokens = await refreshTokens(c, decryptSecret(current.encryptedRefreshToken));
    } catch (err) {
      if (err instanceof GithubApiError && err.kind === 'oauth') return { expired: true };
      throw githubError(err, 'Could not renew your GitHub sign-in');
    }
    await tx.githubAccount.update({ where: { userId }, data: tokenData(tokens) });
    return { token: tokens.accessToken };
  });
  if ('token' in outcome) return outcome.token;
  await prisma.githubAccount.deleteMany({ where: { userId } });
  throw notConnected('Your GitHub sign-in expired; connect GitHub again (Settings → GitHub)');
}

/**
 * Runs `fn` with the user's token; on a 401 it refreshes once and tries again. A second 401
 * means GitHub no longer accepts the sign-in: the tokens are deleted (`github_not_connected`).
 */
export async function withUserToken<T>(
  c: GithubConfig,
  userId: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = await userAccessToken(c, userId);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof GithubApiError && err.kind === 'http' && err.status === 401)) throw err;
  }
  const row = await prisma.githubAccount.findUnique({
    where: { userId },
    select: { encryptedRefreshToken: true },
  });
  if (row?.encryptedRefreshToken) {
    const again = await userAccessToken(c, userId, { forceRefresh: true });
    try {
      return await fn(again);
    } catch (err) {
      if (!(err instanceof GithubApiError && err.kind === 'http' && err.status === 401)) throw err;
    }
  }
  await prisma.githubAccount.deleteMany({ where: { userId } });
  throw notConnected('GitHub no longer accepts your sign-in; connect GitHub again');
}

/** The app's installations this user can see (GET /user/installations, every page). */
export function userInstallations(c: GithubConfig, token: string): Promise<GhInstallation[]> {
  return listAll<GhInstallation>(c, '/user/installations', token, (data) => {
    const list = (data as { installations?: unknown } | null)?.installations;
    return Array.isArray(list)
      ? list.filter(
          (i): i is GhInstallation =>
            typeof i === 'object' && i !== null && typeof (i as GhInstallation).id === 'number',
        )
      : [];
  });
}

/** The installation on the user's own account, or null. */
export function ownInstallation(
  installations: GhInstallation[],
  githubUserId: bigint,
): GhInstallation | null {
  return (
    installations.find(
      (i) => i.account?.id !== undefined && BigInt(i.account.id) === githubUserId,
    ) ?? null
  );
}

/** GET /api/github/account. */
export async function githubAccountView(userId: string): Promise<GithubAccountView> {
  const c = githubConfig();
  if (!c) {
    return GithubAccountViewSchema.parse({
      configured: false,
      connected: false,
      login: null,
      connectedAt: null,
      installUrl: null,
      appInstalled: null,
    });
  }
  const row = await prisma.githubAccount.findUnique({ where: { userId } });
  let appInstalled: boolean | null = null;
  let connected = row !== null;
  if (row) {
    try {
      const installations = await withUserToken(c, userId, (token) => userInstallations(c, token));
      appInstalled = ownInstallation(installations, row.githubUserId) !== null;
    } catch (err) {
      if (err instanceof HttpError && err.body.error === 'github_not_connected') connected = false;
      else {
        console.error(
          'Could not list GitHub installations:',
          err instanceof Error ? err.message : 'unknown error',
        );
      }
    }
  }
  return GithubAccountViewSchema.parse({
    configured: true,
    connected,
    login: connected ? (row?.login ?? null) : null,
    connectedAt: connected ? (row?.connectedAt.toISOString() ?? null) : null,
    installUrl: installUrlOf(c),
    appInstalled,
  });
}
