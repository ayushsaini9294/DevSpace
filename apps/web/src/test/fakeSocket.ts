import { act } from '@testing-library/react';

type Handler = (...args: unknown[]) => void;

/**
 * Stands in for a socket.io-client socket in tests (setup.ts mocks `io` to make these). It
 * never connects on its own: a test calls `serverConnect()` and then `serverEmit(...)`.
 */
export class FakeSocket {
  connected = false;
  disconnected = false;
  readonly options: unknown;
  /** Everything the app sent, in order: [event, payload]. */
  readonly sent: [string, unknown][] = [];
  private handlers = new Map<string, Handler[]>();

  constructor(options: unknown) {
    this.options = options;
  }

  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  emit(event: string, payload?: unknown) {
    this.sent.push([event, payload]);
    return this;
  }

  removeAllListeners() {
    this.handlers.clear();
    return this;
  }

  disconnect() {
    this.connected = false;
    this.disconnected = true;
    return this;
  }

  private fire(event: string, ...args: unknown[]) {
    act(() => {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    });
  }

  /** The server accepted the connection. */
  serverConnect() {
    this.connected = true;
    this.fire('connect');
  }

  /** The connection dropped. */
  serverDisconnect() {
    this.connected = false;
    this.fire('disconnect', 'transport close');
  }

  /** The server sent an event. */
  serverEmit(event: string, payload: unknown) {
    this.fire(event, payload);
  }
}

/** Every socket the app opened in this test, oldest first. */
export const sockets: FakeSocket[] = [];

export function createFakeSocket(options?: unknown): FakeSocket {
  const socket = new FakeSocket(options);
  sockets.push(socket);
  return socket;
}

/** The app's current (last opened, still open) socket. */
export function liveSocket(): FakeSocket {
  const socket = sockets.filter((s) => !s.disconnected).at(-1);
  if (!socket) throw new Error('The app has no open socket');
  return socket;
}
