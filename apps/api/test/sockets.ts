import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ProjectJoinAck,
  type ServerToClientEvents,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { attachRealtime, type Realtime } from '../src/realtime/io.ts';
import { app, type TestUser } from './helpers.ts';

/** Socket test helpers (Phase 9): a real Socket.io server on the app, with the Redis adapter. */

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SocketServer {
  server: Server;
  realtime: Realtime;
  port: number;
  close(): Promise<void>;
}

export async function startSocketServer(): Promise<SocketServer> {
  const server = createServer(app);
  const realtime = await attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // Let the adapter's Redis subscriptions settle before anything is sent.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    server,
    realtime,
    port,
    async close() {
      await realtime.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const opened: ClientSocket[] = [];

/** Connects as `user` (or with other headers); resolves once connected, rejects with the error. */
export function connect(
  s: SocketServer,
  user: TestUser | null,
  options: { origin?: string | null; cookie?: string } = {},
): Promise<ClientSocket> {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? env.APP_ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const cookie = options.cookie ?? user?.cookie;
  if (cookie) headers.cookie = cookie;
  const socket: ClientSocket = connectClient(`http://127.0.0.1:${s.port}`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    extraHeaders: headers,
    reconnection: false,
    forceNew: true,
  });
  opened.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

export function closeSockets(): void {
  for (const socket of opened.splice(0)) socket.close();
}

export function join(socket: ClientSocket, projectId: unknown): Promise<ProjectJoinAck> {
  return new Promise((resolve) => {
    socket.emit('project:join', { projectId } as { projectId: string }, resolve);
  });
}

type EventName = keyof ServerToClientEvents;
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

/** Records every `event` the socket receives from now on. */
export function record<E extends EventName>(socket: ClientSocket, event: E): EventArg<E>[] {
  const list: EventArg<E>[] = [];
  socket.on(event as 'invalidate', ((value: EventArg<E>) => list.push(value)) as never);
  return list;
}

/** Waits until `list` has an item matching `match` (default 15 s). */
export async function waitFor<T>(
  list: T[],
  match: (item: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = list.find(match);
    if (found !== undefined) return found;
    if (Date.now() > until) {
      throw new Error(`Timed out waiting for an event; got ${JSON.stringify(list)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
