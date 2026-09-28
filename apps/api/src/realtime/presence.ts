import {
  PRESENCE_ACTIVE_TTL_SECONDS,
  PRESENCE_REPORT_INTERVAL_MS,
  PresenceViewSchema,
  type PresenceReport,
  type PresenceView,
} from '@devspace/shared';
import { prisma } from '../lib/prisma.ts';
import { realtimeKey, sendPresence } from './emitter.ts';
import { getRedis } from './redis.ts';

/**
 * Presence (Phase 9), kept in Redis with short expiries; nothing goes to PostgreSQL per
 * heartbeat. Per (project, user):
 * - the latest IDE report (`ide`), kept 90 s: `active` → Active with the file; otherwise Online;
 * - open app sockets that joined the project (`online`, a sorted set of `<user>|<socket>` with
 *   an expiry each, refreshed by the socket while it stays);
 * - otherwise Offline, with `ProjectMember.lastSeenAt` (written at most once a minute).
 */

/** How long a socket's "online" mark lasts without a refresh. */
export const SOCKET_ONLINE_TTL_MS = 60_000;
/** How often a connected socket refreshes it. */
export const SOCKET_REFRESH_MS = 20_000;
const LAST_SEEN_EVERY_SECONDS = 60;

interface IdeEntry {
  file: string | null;
  active: boolean;
  copyOwner: { id: string; name: string } | null;
  at: number;
}

const k = {
  ide: (projectId: string, userId: string) => `${realtimeKey()}:ps:ide:${projectId}:${userId}`,
  online: (projectId: string) => `${realtimeKey()}:ps:online:${projectId}`,
  expiry: () => `${realtimeKey()}:ps:expiry`,
  seen: (projectId: string, userId: string) => `${realtimeKey()}:ps:seen:${projectId}:${userId}`,
  rate: (sessionId: string) => `${realtimeKey()}:ps:rate:${sessionId}`,
};

function parseEntry(raw: string | null): IdeEntry | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as IdeEntry;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

interface MemberRow {
  user: { id: string; name: string };
  lastSeenAt: Date | null;
}

function view(member: MemberRow, entry: IdeEntry | null, online: boolean): PresenceView {
  const base = { user: member.user, lastSeenAt: member.lastSeenAt?.toISOString() ?? null };
  if (entry?.active) {
    return PresenceViewSchema.parse({
      ...base,
      state: 'active',
      file: entry.file,
      copyOwner: entry.copyOwner,
    });
  }
  return PresenceViewSchema.parse({
    ...base,
    state: entry || online ? 'online' : 'offline',
    file: null,
    copyOwner: null,
  });
}

/** The user ids with a live app socket in the project. */
async function onlineUsers(projectId: string, now = Date.now()): Promise<Set<string>> {
  const members = await getRedis().zrangebyscore(k.online(projectId), now, '+inf');
  return new Set(members.map((m) => m.split('|', 1)[0]!));
}

const memberSelect = {
  lastSeenAt: true,
  user: { select: { id: true, name: true } },
} as const;

/** Every member's presence (GET /api/projects/:projectId/presence), in the members' order. */
export async function listPresence(projectId: string): Promise<PresenceView[]> {
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    select: memberSelect,
  });
  if (members.length === 0) return [];
  let entries: (string | null)[] = members.map(() => null);
  let online = new Set<string>();
  try {
    const redis = getRedis();
    [entries, online] = await Promise.all([
      redis.mget(members.map((m) => k.ide(projectId, m.user.id))),
      onlineUsers(projectId),
    ]);
  } catch (err) {
    console.error('Could not read presence:', err instanceof Error ? err.message : err);
  }
  return members.map((m, i) => view(m, parseEntry(entries[i] ?? null), online.has(m.user.id)));
}

/** One member's presence, or null if they aren't a member. */
export async function memberPresence(
  projectId: string,
  userId: string,
): Promise<PresenceView | null> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: memberSelect,
  });
  if (!member) return null;
  const redis = getRedis();
  const [raw, online] = await Promise.all([
    redis.get(k.ide(projectId, userId)),
    onlineUsers(projectId),
  ]);
  return view(member, parseEntry(raw), online.has(userId));
}

/** Sends one member's current presence to the project's room (never throws). */
export async function broadcastPresence(projectId: string, userId: string): Promise<void> {
  try {
    const member = await memberPresence(projectId, userId);
    if (member) sendPresence(projectId, member);
  } catch (err) {
    console.error('Could not send presence:', err instanceof Error ? err.message : err);
  }
}

/** Writes `ProjectMember.lastSeenAt` at most once a minute per (project, user). */
export async function touchLastSeen(projectId: string, userId: string): Promise<void> {
  const first = await getRedis().set(
    k.seen(projectId, userId),
    '1',
    'EX',
    LAST_SEEN_EVERY_SECONDS,
    'NX',
  );
  if (first !== 'OK') return;
  await prisma.projectMember.updateMany({
    where: { projectId, userId },
    data: { lastSeenAt: new Date() },
  });
}

// ---------- IDE reports ----------

export interface IdeReporter {
  /** The IDE session (hash of its cookie), for the rate limit. */
  sessionId: string;
  /** Who is using the IDE (the owner, or a helping lead). */
  userId: string;
  copy: { id: string; projectId: string; ownerId: string };
}

/**
 * Stores a (validated) tracker report and tells the project when the member's presence changed.
 * At most one report per 5 s per IDE session is used; extras are dropped. Returns whether it
 * was used. Never throws for Redis trouble (logged).
 */
export async function recordIdeReport(who: IdeReporter, report: PresenceReport): Promise<boolean> {
  const redis = getRedis();
  const allowed = await redis.set(
    k.rate(who.sessionId),
    '1',
    'PX',
    PRESENCE_REPORT_INTERVAL_MS,
    'NX',
  );
  if (allowed !== 'OK') return false;

  const { projectId } = who.copy;
  const users = await prisma.user.findMany({
    where: { id: { in: [who.userId, who.copy.ownerId] } },
    select: { id: true, name: true, shareOpenFile: true },
  });
  const reporter = users.find((u) => u.id === who.userId);
  if (!reporter) return false;
  const owner = users.find((u) => u.id === who.copy.ownerId);
  const share = reporter.shareOpenFile;
  const entry: IdeEntry = {
    active: report.active,
    // The off switch: stored (and so sent) as null.
    file: report.active && share ? report.file : null,
    copyOwner: who.copy.ownerId !== who.userId && owner ? { id: owner.id, name: owner.name } : null,
    at: Date.now(),
  };
  const key = k.ide(projectId, who.userId);
  const previous = parseEntry(await redis.get(key));
  await redis
    .multi()
    .set(key, JSON.stringify(entry), 'EX', PRESENCE_ACTIVE_TTL_SECONDS)
    .zadd(k.expiry(), entry.at + PRESENCE_ACTIVE_TTL_SECONDS * 1000, `${projectId}|${who.userId}`)
    .exec();
  await touchLastSeen(projectId, who.userId).catch(() => undefined);
  const changed =
    !previous ||
    previous.active !== entry.active ||
    previous.file !== entry.file ||
    previous.copyOwner?.id !== entry.copyOwner?.id;
  if (changed) await broadcastPresence(projectId, who.userId);
  return true;
}

/**
 * The share switch was turned off: drop the file from every stored IDE report of the user now
 * (rather than on their next heartbeat), and tell those projects.
 */
export async function hideOpenFile(userId: string): Promise<void> {
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  const redis = getRedis();
  for (const { projectId } of memberships) {
    const key = k.ide(projectId, userId);
    const entry = parseEntry(await redis.get(key));
    if (!entry?.file) continue;
    const ttl = await redis.pttl(key);
    if (ttl <= 0) continue;
    await redis.set(key, JSON.stringify({ ...entry, file: null }), 'PX', ttl);
    await broadcastPresence(projectId, userId);
  }
}

/**
 * IDE reports that ran out (the IDE was closed): tell their projects. Safe from several
 * processes at once (only the one whose ZREM wins sends). Returns how many were announced.
 */
export async function sweepPresence(now = Date.now()): Promise<number> {
  const redis = getRedis();
  const due = await redis.zrangebyscore(k.expiry(), '-inf', now);
  let sent = 0;
  for (const item of due) {
    if ((await redis.zrem(k.expiry(), item)) !== 1) continue;
    const [projectId, userId] = item.split('|');
    if (!projectId || !userId) continue;
    // A newer report re-added the item with a later score; a key still present means it's alive.
    if (await redis.exists(k.ide(projectId, userId))) continue;
    await broadcastPresence(projectId, userId);
    sent++;
  }
  return sent;
}

// ---------- App sockets ----------

/** Marks the socket online in the project; announces the member if they weren't online. */
export async function socketJoined(
  projectId: string,
  userId: string,
  socketId: string,
): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const wasOnline = (await onlineUsers(projectId, now)).has(userId);
  const hadIde = (await redis.exists(k.ide(projectId, userId))) === 1;
  await redis.zadd(k.online(projectId), now + SOCKET_ONLINE_TTL_MS, `${userId}|${socketId}`);
  // Old marks of crashed processes go too.
  await redis.zremrangebyscore(k.online(projectId), '-inf', now);
  await touchLastSeen(projectId, userId).catch(() => undefined);
  if (!wasOnline && !hadIde) await broadcastPresence(projectId, userId);
}

/** Keeps the socket's mark alive (every 20 s while it stays in the room). */
export async function socketRefresh(
  projectId: string,
  userId: string,
  socketId: string,
): Promise<void> {
  await getRedis().zadd(
    k.online(projectId),
    Date.now() + SOCKET_ONLINE_TTL_MS,
    `${userId}|${socketId}`,
  );
  await touchLastSeen(projectId, userId).catch(() => undefined);
}

/** The socket left the project (or disconnected); announces the member if they're now gone. */
export async function socketLeft(
  projectId: string,
  userId: string,
  socketId: string,
): Promise<void> {
  const redis = getRedis();
  const removed = await redis.zrem(k.online(projectId), `${userId}|${socketId}`);
  if (removed !== 1) return;
  await touchLastSeen(projectId, userId).catch(() => undefined);
  const stillOnline = (await onlineUsers(projectId)).has(userId);
  const hasIde = (await redis.exists(k.ide(projectId, userId))) === 1;
  if (!stillOnline && !hasIde) await broadcastPresence(projectId, userId);
}

/** A member left or was removed: forget their presence in that project. */
export async function forgetPresence(projectId: string, userId: string): Promise<void> {
  const redis = getRedis();
  const marks = await redis.zrange(k.online(projectId), '0', '-1');
  const mine = marks.filter((m) => m.startsWith(`${userId}|`));
  const multi = redis.multi().del(k.ide(projectId, userId));
  if (mine.length > 0) multi.zrem(k.online(projectId), ...mine);
  await multi.exec();
}
