import http, {
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import { findSessionUser, readSessionToken } from '../auth/session.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { IDE_PORT } from './docker.ts';
import { forgetIdeTarget, getIdeTarget, recordIdeActivity, type IdeTarget } from './service.ts';

/**
 * /ide/<copyId>/… (HTTP and WebSockets) → that copy's IDE container. Only the copy's owner,
 * while still a member of its project, gets through; everyone else (and anyone not logged in)
 * gets the same 404 as an unknown copy. The target is always the container we started for that
 * copy (never anything taken from the request), the connection token is added here, and the
 * browser's own cookies and credentials are never forwarded.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Request headers never forwarded: hop-by-hop ones, and the browser's credentials. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

/** Response headers never passed back: hop-by-hop ones, and cookies (the IDE may not set any). */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

const ideNotFound = () => new HttpError(404, 'not_found', 'Not found');
const ideNotRunning = () =>
  new HttpError(503, 'ide_not_running', "The IDE isn't running; open it again from the project");

/** `/ide/<copyId>` or `/ide/<copyId>/…` → the copy id and whether the slash is missing. */
export function parseIdePath(url: string): { copyId: string; bare: boolean } | null {
  const path = url.split('?', 1)[0]!;
  const match = /^\/ide\/([^/]+)(\/.*)?$/.exec(path);
  if (!match || !UUID.test(match[1]!)) return null;
  return { copyId: match[1]!, bare: match[2] === undefined };
}

/** The copy if `userId` owns it and is still a member of its project; else null. */
async function ownedCopy(copyId: string, userId: string) {
  return prisma.copy.findFirst({
    where: { id: copyId, userId, project: { members: { some: { userId } } } },
    select: { id: true, containerStatus: true },
  });
}

function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  return new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** What the container receives: the request's headers minus credentials, plus the token. */
export function forwardHeaders(headers: IncomingHttpHeaders, token: string): OutgoingHttpHeaders {
  const listed = connectionListed(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  out.cookie = `vscode-tkn=${token}`;
  return out;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionListed(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Mounted at /ide after cookie parsing and `loadSession`. */
export const ideProxy: RequestHandler = async (req, res) => {
  const parsed = parseIdePath(req.originalUrl);
  if (!parsed || !req.user) throw ideNotFound();
  const copy = await ownedCopy(parsed.copyId, req.user.id);
  if (!copy) throw ideNotFound();
  if (parsed.bare) {
    const query = req.originalUrl.indexOf('?');
    const search = query >= 0 ? req.originalUrl.slice(query) : '';
    res.redirect(308, `/ide/${copy.id}/${search}`);
    return;
  }
  if (copy.containerStatus !== 'running') throw ideNotRunning();
  const target = await getIdeTarget(copy.id);
  if (!target) throw ideNotRunning();
  recordIdeActivity(copy.id);

  const upstream = http.request({
    host: target.ip,
    port: IDE_PORT,
    method: req.method,
    path: req.originalUrl,
    headers: forwardHeaders(req.headers, target.token),
  });
  upstream.on('response', (answer) => {
    res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
    answer.pipe(res);
  });
  upstream.on('error', () => {
    forgetIdeTarget(copy.id);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ error: 'ide_unreachable', message: "The IDE isn't answering; open it again" });
    } else {
      res.destroy();
    }
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
};

// ---------- WebSockets ----------

/** Cookie header → name/value pairs (first value wins, like cookie-parser). */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value, as cookie-parser does.
    }
    out[name] = value;
  }
  return out;
}

/** A browser's WebSocket must come from the page's own origin (no cross-site hijacking). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // not a browser; the session cookie is still required
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** The upgrade request as the container sees it: same line, filtered headers, the token. */
function upgradeRequest(req: IncomingMessage, target: IdeTarget): string {
  const headers = forwardHeaders(req.headers, target.token);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  let text = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) text += `${name}: ${one}\r\n`;
  }
  return `${text}\r\n`;
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const parsed = parseIdePath(req.url ?? '');
  if (!parsed || parsed.bare) return refuse(socket, 404);
  if (!sameOrigin(req)) return refuse(socket, 403);
  const token = readSessionToken(parseCookies(req.headers.cookie));
  const user = token ? await findSessionUser(token) : null;
  const copy = user ? await ownedCopy(parsed.copyId, user.id) : null;
  if (!copy) return refuse(socket, 404);
  if (copy.containerStatus !== 'running') return refuse(socket, 503);
  const target = await getIdeTarget(copy.id);
  if (!target) return refuse(socket, 503);
  if (socket.destroyed) return;
  recordIdeActivity(copy.id);

  const upstream = net.connect(IDE_PORT, target.ip);
  upstream.once('connect', () => {
    upstream.write(upgradeRequest(req, target));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on('data', () => recordIdeActivity(copy.id));
  });
  upstream.on('error', () => {
    forgetIdeTarget(copy.id);
    socket.destroy();
  });
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

/**
 * Handles WebSocket upgrades under /ide/ on `server`. Other upgrade paths are left to other
 * listeners (e.g. Socket.io later), or closed if there are none.
 */
export function attachIdeUpgrades(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!(req.url ?? '').startsWith('/ide/')) {
      if (server.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error('IDE WebSocket failed:', err instanceof Error ? err.message : err);
      refuse(socket, 502);
    });
  });
}
