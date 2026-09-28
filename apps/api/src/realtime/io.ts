import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import {
  ProjectRoomRequestSchema,
  SESSION_COOKIE_NAME,
  SOCKET_EVENTS,
  SOCKET_PATH,
  type ClientToServerEvents,
  type ProjectJoinAck,
  type ServerToClientEvents,
} from '@devspace/shared';
import { env } from '../config/env.ts';
import { findSessionUser, hashSessionToken } from '../auth/session.ts';
import { cookieValues } from '../ide/proxy.ts';
import { prisma } from '../lib/prisma.ts';
import { projectRoom, realtimeKey, sessionRoom, userRoom } from './emitter.ts';
import { SOCKET_REFRESH_MS, socketJoined, socketLeft, socketRefresh } from './presence.ts';

/**
 * The app's live connection (Phase 9): Socket.io on the main API port, path /socket.io, with the
 * Redis adapter so events sent by any process (or the worker's emitter) reach every socket.
 *
 * - Handshake: `Origin` must be APP_ORIGIN (so the IDE site never gets a socket) and the app's
 *   session cookie must be valid. Refusals are connect_errors `forbidden_origin` /
 *   `unauthenticated`.
 * - Every socket joins `user:<id>` and `session:<id>` (logging out disconnects it).
 * - `project:join` checks membership before joining `project:<id>` (and again right after, so a
 *   removal racing the join can't leave it inside). Removal and deletion make sockets leave.
 */

interface SocketData {
  userId: string;
  sessionId: string;
  projects: Set<string>;
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

class RefusedError extends Error {
  readonly data: { error: string };
  constructor(code: string) {
    super(code);
    this.data = { error: code };
  }
}

async function isMember(projectId: string, userId: string): Promise<boolean> {
  const count = await prisma.projectMember.count({ where: { projectId, userId } });
  return count > 0;
}

function answer(ack: unknown, value: ProjectJoinAck): void {
  if (typeof ack === 'function') (ack as (v: ProjectJoinAck) => void)(value);
}

function logged(label: string, promise: Promise<unknown>): void {
  promise.catch((err: unknown) =>
    console.error(`${label}:`, err instanceof Error ? err.message : err),
  );
}

async function join(socket: AppSocket, raw: unknown): Promise<ProjectJoinAck> {
  const parsed = ProjectRoomRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'validation_error' };
  const { projectId } = parsed.data;
  const { userId } = socket.data;
  if (!(await isMember(projectId, userId))) return { ok: false, error: 'not_found' };
  await socket.join(projectRoom(projectId));
  // Removed between the check and the join: undo.
  if (!(await isMember(projectId, userId))) {
    await socket.leave(projectRoom(projectId));
    return { ok: false, error: 'not_found' };
  }
  if (!socket.data.projects.has(projectId)) {
    socket.data.projects.add(projectId);
    logged('Could not record presence', socketJoined(projectId, userId, socket.id));
  }
  return { ok: true };
}

async function leave(socket: AppSocket, projectId: string): Promise<void> {
  await socket.leave(projectRoom(projectId));
  if (socket.data.projects.delete(projectId)) {
    await socketLeft(projectId, socket.data.userId, socket.id);
  }
}

function onConnection(socket: AppSocket): void {
  const { userId, sessionId } = socket.data;
  void socket.join([userRoom(userId), sessionRoom(sessionId)]);

  socket.on(SOCKET_EVENTS.join, (raw, ack) => {
    join(socket, raw)
      .then((value) => answer(ack, value))
      .catch((err: unknown) => {
        console.error('project:join failed:', err instanceof Error ? err.message : err);
        answer(ack, { ok: false, error: 'internal_error' });
      });
  });

  socket.on(SOCKET_EVENTS.leave, (raw, ack) => {
    const parsed = ProjectRoomRequestSchema.safeParse(raw);
    if (!parsed.success) return answer(ack, { ok: false, error: 'validation_error' });
    leave(socket, parsed.data.projectId)
      .catch((err: unknown) =>
        console.error('project:leave failed:', err instanceof Error ? err.message : err),
      )
      .finally(() => answer(ack, { ok: true }));
  });

  // Rooms can also be left from elsewhere (a removal, a deleted project): stop presence there.
  const refresh = setInterval(() => {
    for (const projectId of [...socket.data.projects]) {
      if (!socket.rooms.has(projectRoom(projectId))) {
        logged('Could not update presence', leave(socket, projectId));
        continue;
      }
      logged('Could not refresh presence', socketRefresh(projectId, userId, socket.id));
    }
  }, SOCKET_REFRESH_MS);
  refresh.unref();

  socket.on('disconnect', () => {
    clearInterval(refresh);
    for (const projectId of socket.data.projects) {
      logged('Could not update presence', socketLeft(projectId, userId, socket.id));
    }
    socket.data.projects.clear();
  });
}

export interface Realtime {
  io: RealtimeServer;
  close(): Promise<void>;
}

/** Attaches Socket.io to the main API server. */
export async function attachRealtime(httpServer: HttpServer): Promise<Realtime> {
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const sub = pub.duplicate();
  for (const client of [pub, sub]) {
    client.on('error', (err: Error) => console.error('Live updates Redis error:', err.message));
  }
  const io: RealtimeServer = new Server(httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    // Same origin through the app (Vite proxies /socket.io in dev): no CORS headers at all.
    cors: undefined,
    adapter: createAdapter(pub, sub, { key: realtimeKey() }),
  });

  io.use((socket, next) => {
    void (async () => {
      if (socket.handshake.headers.origin !== env.APP_ORIGIN) {
        throw new RefusedError('forbidden_origin');
      }
      const token = cookieValues(socket.handshake.headers.cookie, SESSION_COOKIE_NAME)[0];
      const user = token ? await findSessionUser(token) : null;
      if (!token || !user) throw new RefusedError('unauthenticated');
      socket.data.userId = user.id;
      socket.data.sessionId = hashSessionToken(token);
      socket.data.projects = new Set();
    })().then(
      () => next(),
      (err: unknown) => {
        if (err instanceof RefusedError) next(err);
        else {
          console.error('Socket handshake failed:', err instanceof Error ? err.message : err);
          next(new RefusedError('internal_error'));
        }
      },
    );
  });

  io.on('connection', onConnection);

  return {
    io,
    async close() {
      // Not io.close(): that would also close the HTTP server, which index.ts owns.
      io.local.disconnectSockets(true);
      io.engine.close();
      await pub.quit().catch(() => undefined);
      await sub.quit().catch(() => undefined);
    },
  };
}
