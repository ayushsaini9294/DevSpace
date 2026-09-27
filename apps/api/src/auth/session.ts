import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { SESSION_COOKIE_NAME } from '@devspace/shared';
import { env } from '../config/env.ts';
import { prisma } from '../lib/prisma.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** The user attached to a request by `loadSession`. Never includes the password hash. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export const authUserSelect = { id: true, name: true, email: true, createdAt: true } as const;

/** Sessions are stored by the SHA-256 hex hash of their token, never the token itself. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new random token (goes only into the cookie), its database id and its expiry. */
export function newSessionToken(): { token: string; id: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: hashSessionToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const { token, id, expiresAt } = newSessionToken();
  await prisma.session.create({ data: { id, userId, expiresAt } });
  return { token, expiresAt };
}

/**
 * Returns the session's user, or null if the token is unknown or expired.
 * Expired sessions are deleted here.
 */
export async function findSessionUser(token: string): Promise<AuthUser | null> {
  const id = hashSessionToken(token);
  const session = await prisma.session.findUnique({
    where: { id },
    select: { expiresAt: true, user: { select: authUserSelect } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.deleteMany({ where: { id } });
    return null;
  }
  return session.user;
}

export async function deleteSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: hashSessionToken(token) } });
}

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
};

export const sessionCookie = {
  name: SESSION_COOKIE_NAME,
  set: { ...baseCookieOptions, maxAge: SESSION_TTL_MS } satisfies CookieOptions,
  clear: baseCookieOptions,
};

/** Reads the raw session token from parsed request cookies, if present. */
export function readSessionToken(cookies: unknown): string | undefined {
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
