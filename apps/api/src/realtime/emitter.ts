import { Emitter } from '@socket.io/redis-emitter';
import {
  SOCKET_EVENTS,
  type InvalidateKey,
  type NotificationEvent,
  type PresenceView,
} from '@devspace/shared';
import { env } from '../config/env.ts';
import { afterCommit, transactionState } from '../lib/transaction.ts';
import { closeRedis, getRedis } from './redis.ts';

/**
 * Sending live events (Phase 9). Everything goes through Redis (`@socket.io/redis-emitter`), so
 * the API and the worker send the same way, and every API process's Socket.io server (joined by
 * `@socket.io/redis-adapter` on the same key) delivers to its own sockets. Sending is best
 * effort: if Redis is down, the error is logged and the web app's polling catches up.
 */

export const projectRoom = (projectId: string) => `project:${projectId}`;
export const userRoom = (userId: string) => `user:${userId}`;
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/** The Redis key prefix shared by the adapter and the emitter. */
let channelKey = env.NODE_ENV === 'test' ? `devspace-test-${process.pid}` : 'devspace-socket.io';

let emitter: Emitter | null = null;

/** The key the Socket.io Redis adapter must use to hear these events. */
export function realtimeKey(): string {
  return channelKey;
}

/** Tests: use another key (call before creating a server or sending). */
export function useRealtimeKey(key: string): void {
  channelKey = key;
  emitter = null;
}

function getEmitter(): Emitter {
  if (!emitter) {
    const client = getRedis();
    // The emitter publishes without waiting: catch here so a Redis outage never crashes us.
    const publisher = {
      publish(channel: string, message: string | Buffer) {
        return client.publish(channel, message).catch((err: unknown) => {
          console.error('Could not send a live update:', err instanceof Error ? err.message : err);
          return 0;
        });
      },
    };
    emitter = new Emitter(publisher, { key: channelKey });
  }
  return emitter;
}

function safely(send: () => void): void {
  try {
    send();
  } catch (err) {
    console.error('Could not send a live update:', err instanceof Error ? err.message : err);
  }
}

/** `invalidate` to the project's room, right now (use `invalidateAfterCommit` in transactions). */
export function sendInvalidate(projectId: string, keys: Iterable<InvalidateKey>): void {
  const list = [...new Set(keys)];
  if (list.length === 0) return;
  safely(() =>
    getEmitter()
      .to(projectRoom(projectId))
      .emit(SOCKET_EVENTS.invalidate, { projectId, keys: list }),
  );
}

const INVALIDATIONS = Symbol('invalidations');

/**
 * Queues `invalidate` for after `db`'s transaction commits (right away with the plain client).
 * Several calls in one transaction are merged into one event per project.
 */
export async function invalidateAfterCommit(
  db: object,
  projectId: string,
  keys: Iterable<InvalidateKey>,
): Promise<void> {
  const merged = transactionState(db, INVALIDATIONS, () => new Map<string, Set<InvalidateKey>>());
  if (!merged) {
    await afterCommit(db, () => sendInvalidate(projectId, keys));
    return;
  }
  const first = merged.size === 0;
  let set = merged.get(projectId);
  if (!set) merged.set(projectId, (set = new Set()));
  for (const key of keys) set.add(key);
  if (first) {
    await afterCommit(db, () => {
      for (const [id, one] of merged) sendInvalidate(id, one);
    });
  }
}

/** `presence` to the project's room. */
export function sendPresence(projectId: string, member: PresenceView): void {
  safely(() =>
    getEmitter().to(projectRoom(projectId)).emit(SOCKET_EVENTS.presence, { projectId, member }),
  );
}

/** `notification` to one user's sockets only. */
export function sendNotification(userId: string, event: NotificationEvent): void {
  safely(() => getEmitter().to(userRoom(userId)).emit(SOCKET_EVENTS.notification, event));
}

/**
 * A member left or was removed: their sockets leave the project's room at once (on every API
 * process) and are told so.
 */
export function removeUserFromProject(projectId: string, userId: string): void {
  safely(() => {
    const e = getEmitter();
    e.in(userRoom(userId)).socketsLeave(projectRoom(projectId));
    e.to(userRoom(userId)).emit(SOCKET_EVENTS.projectRemoved, { projectId });
  });
}

/** A project was deleted: everyone in its room is told, then leaves it. */
export function closeProjectRoom(projectId: string): void {
  safely(() => {
    const e = getEmitter();
    e.to(projectRoom(projectId)).emit(SOCKET_EVENTS.projectRemoved, { projectId });
    e.in(projectRoom(projectId)).socketsLeave(projectRoom(projectId));
  });
}

/** Logging out ends that session's sockets. */
export function disconnectSession(sessionId: string): void {
  safely(() => getEmitter().in(sessionRoom(sessionId)).disconnectSockets(true));
}

/** On shutdown. */
export async function closeEmitter(): Promise<void> {
  emitter = null;
  await closeRedis();
}
