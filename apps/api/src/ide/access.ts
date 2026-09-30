import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';

/**
 * Getting into the IDE site, which never sees the app's session cookie:
 * 1. The app asks POST …/copy/ide/launch → a one-time ticket in a URL on IDE_ORIGIN.
 * 2. GET /ide-launch?ticket= on the IDE listener uses the ticket up and sets `devspace_ide`,
 *    an opaque id valid for one user in one copy (12 h), scoped to `/ide/<copyId>/`.
 * Tickets and cookie ids are random 32-byte values, stored only as SHA-256 hashes.
 */

export const TICKET_TTL_MS = 60_000;
export const IDE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const IDE_COOKIE_NAME = 'devspace_ide';
/** The cookie VS Code's browser client reads its connection token from. */
export const VSCODE_TOKEN_COOKIE = 'vscode-tkn';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The copy if `userId` owns it and is still a member of its project; else null. */
export async function ownedCopy(copyId: string, userId: string) {
  return prisma.copy.findFirst({
    where: { id: copyId, userId, project: { members: { some: { userId } } } },
    select: { id: true, containerStatus: true },
  });
}

/**
 * The copy if `userId` may open it in the IDE right now; else null. That is its owner (still a
 * member of the project), or — Phase 7, a lead helping — a current leader or co-leader of the
 * copy's project while the owner is still a member. Checked on every request, so a lead who is
 * demoted or removed loses access at once.
 */
export async function accessibleCopy(copyId: string, userId: string) {
  const owned = await ownedCopy(copyId, userId);
  if (owned) return owned;
  const copy = await prisma.copy.findFirst({
    where: {
      id: copyId,
      project: { members: { some: { userId, role: { in: ['leader', 'co_leader'] } } } },
    },
    select: { id: true, containerStatus: true, userId: true, projectId: true },
  });
  if (!copy) return null;
  const ownerIsMember = await prisma.projectMember.count({
    where: { projectId: copy.projectId, userId: copy.userId },
  });
  return ownerIsMember > 0 ? { id: copy.id, containerStatus: copy.containerStatus } : null;
}

/**
 * Makes a launch ticket bound to (user, copy) and returns the URL that carries it. The user is
 * the copy's owner, or a lead opening a member's copy (the caller checks which). With
 * `previewPort` (Phase 11) the URL lands on that port's Preview instead of the IDE:
 * `…/ide-launch?ticket=…&next=__preview/<port>/`.
 */
export async function createLaunchUrl(
  userId: string,
  copyId: string,
  previewPort?: number,
): Promise<string> {
  const now = new Date();
  // Housekeeping: nothing expired is ever used, so it can go.
  await prisma.ideTicket.deleteMany({ where: { expiresAt: { lt: now } } });
  const ticket = randomSecret();
  await prisma.ideTicket.create({
    data: {
      id: hash(ticket),
      userId,
      copyId,
      expiresAt: new Date(now.getTime() + TICKET_TTL_MS),
    },
  });
  const url = new URL('/ide-launch', env.IDE_ORIGIN);
  url.searchParams.set('ticket', ticket);
  // Slashes are fine in a query; written as-is so the link reads like the contract says.
  const next = previewPort === undefined ? '' : `&next=__preview/${previewPort}/`;
  return `${url.toString()}${next}`;
}

/**
 * Uses a ticket up (deleting it, so it works exactly once) and, if it was still valid and its
 * user still owns the copy, starts an IDE session. Returns the cookie value and copy id.
 */
export async function redeemTicket(
  ticket: string,
): Promise<{ cookieValue: string; copyId: string } | null> {
  if (ticket.length < 20 || ticket.length > 200) return null;
  let row: { userId: string; copyId: string; expiresAt: Date };
  try {
    row = await prisma.ideTicket.delete({
      where: { id: hash(ticket) },
      select: { userId: true, copyId: true, expiresAt: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
    throw err;
  }
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) return null;
  if (!(await accessibleCopy(row.copyId, row.userId))) return null;

  await prisma.ideSession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  const cookieValue = randomSecret();
  await prisma.ideSession.create({
    data: {
      id: hash(cookieValue),
      userId: row.userId,
      copyId: row.copyId,
      expiresAt: new Date(now + IDE_SESSION_TTL_MS),
    },
  });
  return { cookieValue, copyId: row.copyId };
}

/**
 * The copy an IDE cookie value opens, if the session is for `copyId`, hasn't expired, and its
 * user may still open the copy (its owner, or a current lead: see accessibleCopy). Checked on
 * every request.
 */
export async function ideSessionCopy(cookieValue: string, copyId: string) {
  if (cookieValue.length < 20 || cookieValue.length > 200) return null;
  const session = await prisma.ideSession.findUnique({
    where: { id: hash(cookieValue) },
    select: { userId: true, copyId: true, expiresAt: true },
  });
  if (!session || session.copyId !== copyId || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return accessibleCopy(copyId, session.userId);
}

/**
 * Like ideSessionCopy, but also says who is using the IDE (Phase 9 presence reports): the
 * session's id (the cookie's hash), its user, and the copy's project and owner.
 */
export async function ideSessionUser(cookieValue: string, copyId: string) {
  if (cookieValue.length < 20 || cookieValue.length > 200) return null;
  const sessionId = hash(cookieValue);
  const session = await prisma.ideSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, copyId: true, expiresAt: true },
  });
  if (!session || session.copyId !== copyId || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  if (!(await accessibleCopy(copyId, session.userId))) return null;
  const copy = await prisma.copy.findUnique({
    where: { id: copyId },
    select: { id: true, projectId: true, userId: true },
  });
  if (!copy) return null;
  return {
    sessionId,
    userId: session.userId,
    copy: { id: copy.id, projectId: copy.projectId, ownerId: copy.userId },
  };
}

/** Cookie attributes shared by both IDE-site cookies (set inside a cross-site iframe). */
function ideCookieAttributes(copyId: string): string[] {
  return [
    `Path=/ide/${copyId}/`,
    `Max-Age=${IDE_SESSION_TTL_MS / 1000}`,
    'Secure',
    'SameSite=None',
    'Partitioned',
  ];
}

/** The Set-Cookie value for a new IDE session: HttpOnly, never readable by page scripts. */
export function ideCookieHeader(cookieValue: string, copyId: string): string {
  return [`${IDE_COOKIE_NAME}=${cookieValue}`, ...ideCookieAttributes(copyId), 'HttpOnly'].join(
    '; ',
  );
}

/**
 * The Set-Cookie value that hands the container's connection token to VS Code's own page.
 * VS Code's browser client reads it from `vscode-tkn` in JavaScript (and sends it in its
 * WebSocket auth message), so it can't be HttpOnly. It is set only on the IDE site, only for
 * this copy's path: the app's origin never sees it, and the member can read the same token in
 * their own container anyway. The proxy still adds the token on the server side as well.
 */
export function vscodeTokenCookieHeader(token: string, copyId: string): string {
  return [`${VSCODE_TOKEN_COOKIE}=${token}`, ...ideCookieAttributes(copyId)].join('; ');
}
