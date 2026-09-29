import http, {
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { MAX_IDE_FINDINGS_BYTES, PresenceReportSchema } from '@devspace/shared';
import { receiveIdeFindings } from '../ai/ide-review.ts';
import { getRedis } from '../realtime/redis.ts';
import { env } from '../config/env.ts';
import { recordIdeReport } from '../realtime/presence.ts';
import {
  IDE_COOKIE_NAME,
  ideCookieHeader,
  ideSessionCopy,
  ideSessionUser,
  redeemTicket,
  vscodeTokenCookieHeader,
} from './access.ts';
import { CONTAINER_PORT } from './docker.ts';
import { forgetIdeTarget, getIdeTarget, recordIdeActivity, type IdeTarget } from './service.ts';

/**
 * The IDE site: a separate listener (IDE_PORT, public address IDE_ORIGIN, a different site from
 * the app) so code running in a member's container never runs on the app's origin. It serves
 * only:
 * - GET /ide-launch?ticket=… — uses up a one-time ticket, sets the `devspace_ide` cookie for
 *   that copy, and redirects to /ide/<copyId>/;
 * - /ide/<copyId>/… (HTTP and WebSockets) — proxied to that copy's container while the cookie's
 *   user still owns the copy and is a member of its project.
 * Everything else, and every refusal, is the same plain 404. The app's session cookie is never
 * read here. The target is always the container we started for the copy, the connection token
 * is added here, and the browser's own cookies and credentials are never forwarded.
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

/**
 * Response headers never passed back: hop-by-hop ones, cookies (only we set cookies on this
 * site), and X-Frame-Options (framing is decided by our frame-ancestors).
 */
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
  'x-frame-options',
]);

/**
 * Only the app may frame the IDE, plus the IDE site itself: VS Code runs its web extension host
 * in a nested same-origin iframe, and frame-ancestors checks every ancestor (lead, Phase 9).
 */
function frameAncestors(): string {
  return `frame-ancestors 'self' ${env.APP_ORIGIN}`;
}

/** `/ide/<copyId>` or `/ide/<copyId>/…` → the copy id and whether the slash is missing. */
export function parseIdePath(url: string): { copyId: string; bare: boolean } | null {
  const path = url.split('?', 1)[0]!;
  const match = /^\/ide\/([^/]+)(\/.*)?$/.exec(path);
  if (!match || !UUID.test(match[1]!)) return null;
  return { copyId: match[1]!, bare: match[2] === undefined };
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
  // Ours is added next to any policy VS Code sends; browsers enforce both.
  const own = out['content-security-policy'];
  const policies = own === undefined ? [] : Array.isArray(own) ? own : [String(own)];
  (out as Record<string, string[]>)['content-security-policy'] = [...policies, frameAncestors()];
  return out;
}

/** Every value of cookie `name` in a Cookie header (a browser may send several paths' values). */
export function cookieValues(header: string | undefined, name: string): string[] {
  const values: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value) values.push(value);
  }
  return values;
}

/** The copy the request's IDE cookie opens, or null. */
async function cookieCopy(req: IncomingMessage, copyId: string) {
  for (const value of cookieValues(req.headers.cookie, IDE_COOKIE_NAME)) {
    const copy = await ideSessionCopy(value, copyId);
    if (copy) return copy;
  }
  return null;
}

const PLAIN_MESSAGES: Record<number, string> = {
  404: 'Not found',
  502: "The IDE isn't answering. Open it again from the project.",
  503: "The IDE isn't running. Open it again from the project.",
};

function plain(res: ServerResponse, status: number): void {
  const body = `${PLAIN_MESSAGES[status] ?? STATUS_CODES[status] ?? ''}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; ${frameAncestors()}`,
  });
  res.end(body);
}

async function launch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET') return plain(res, 404);
  const ticket = url.searchParams.get('ticket');
  const session = ticket ? await redeemTicket(ticket) : null;
  if (!session) return plain(res, 404);
  const cookies = [ideCookieHeader(session.cookieValue, session.copyId)];
  const target = await getIdeTarget(session.copyId);
  if (target) cookies.push(vscodeTokenCookieHeader(target.token, session.copyId));
  res.writeHead(303, {
    location: `/ide/${session.copyId}/`,
    'set-cookie': cookies,
    'cache-control': 'no-store',
    // The ticket is in this URL: never pass it on.
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; ${frameAncestors()}`,
    'content-length': 0,
  });
  res.end();
}

// ---------- DevSpace's own paths under /ide/<copyId>/__devspace/ (never forwarded) ----------

/** Largest presence report body read. */
const MAX_REPORT_BYTES = 4096;

/** `/ide/<copyId>/__devspace/…`: handled here, never sent to the container. */
function isDevspacePath(pathname: string, copyId: string): boolean {
  return pathname.startsWith(`/ide/${copyId}/__devspace/`);
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; ${frameAncestors()}`,
  });
  res.end();
}

/** The body as text, or null if it is larger than `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * POST /ide/<copyId>/__devspace/presence — the tracker extension's report (Phase 9). It comes
 * from VS Code's page on the IDE site with the `devspace_ide` cookie, so the user is whoever
 * is using this IDE (the owner or a helping lead). Everything in it is untrusted: validated,
 * rate limited (1 per 5 s per IDE session), and the answer is always 204 with no body.
 */
async function presenceReport(req: IncomingMessage, res: ServerResponse, copyId: string) {
  try {
    if (req.method !== 'POST') return;
    if (req.headers.origin !== env.IDE_ORIGIN) return;
    const type = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase();
    if (type !== 'application/json') return;
    const text = await readBody(req, MAX_REPORT_BYTES);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const report = PresenceReportSchema.safeParse(json);
    if (!report.success) return;
    let who = null;
    for (const value of cookieValues(req.headers.cookie, IDE_COOKIE_NAME)) {
      who = await ideSessionUser(value, copyId);
      if (who) break;
    }
    if (!who) return;
    const used = await recordIdeReport(who, report.data);
    if (used && report.data.active) recordIdeActivity(copyId);
  } catch (err) {
    console.error('Presence report failed:', err instanceof Error ? err.message : err);
  } finally {
    if (!res.headersSent) noContent(res);
    // Whatever wasn't read is dropped with the connection.
    if (!req.readableEnded) req.resume();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; ${frameAncestors()}`,
  });
  res.end(text);
}

const errorBody = (error: string, message: string) => ({ error, message });

/** Largest findings request body read (the findings text is at most 50 KB, JSON-escaped). */
const MAX_FINDINGS_REQUEST_BYTES = MAX_IDE_FINDINGS_BYTES * 2 + 1024;
/** Fewest milliseconds between two findings from one IDE session. */
const FINDINGS_INTERVAL_MS = 5_000;

/**
 * POST /ide/<copyId>/__devspace/review-findings — the tracker's "DevSpace: Send review findings"
 * command (Phase 10). Checked like presence reports (Origin = IDE_ORIGIN, JSON, the IDE
 * session), and the IDE session's user must own the copy. Answers JSON: 201
 * IdeFindingsResponse, or { error, message }.
 */
async function reviewFindings(req: IncomingMessage, res: ServerResponse, copyId: string) {
  try {
    if (req.method !== 'POST') return json(res, 404, errorBody('not_found', 'Not found'));
    if (req.headers.origin !== env.IDE_ORIGIN) {
      return json(res, 403, errorBody('forbidden', 'Requests must come from the IDE'));
    }
    const type = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase();
    if (type !== 'application/json') {
      return json(
        res,
        415,
        errorBody('unsupported_media_type', 'Content-Type must be application/json'),
      );
    }
    let who = null;
    for (const value of cookieValues(req.headers.cookie, IDE_COOKIE_NAME)) {
      who = await ideSessionUser(value, copyId);
      if (who) break;
    }
    if (!who) return json(res, 404, errorBody('not_found', 'Open the IDE again from DevSpace'));
    const text = await readBody(req, MAX_FINDINGS_REQUEST_BYTES);
    if (text === null) {
      return json(res, 413, errorBody('payload_too_large', 'Findings are larger than 50 KB'));
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, errorBody('bad_request', 'The request is not valid JSON'));
    }
    const allowed = await getRedis().set(
      `devspace:ai:findings-rate:${who.sessionId}`,
      '1',
      'PX',
      FINDINGS_INTERVAL_MS,
      'NX',
    );
    if (allowed !== 'OK') {
      return json(res, 429, errorBody('rate_limited', 'Wait a few seconds before sending again'));
    }
    const answer = await receiveIdeFindings(who, body);
    return json(res, answer.status, answer.body);
  } catch (err) {
    console.error('Review findings failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) json(res, 500, errorBody('internal_error', 'Internal server error'));
  } finally {
    if (!req.readableEnded) req.resume();
  }
}

async function devspacePath(req: IncomingMessage, res: ServerResponse, url: URL, copyId: string) {
  if (url.pathname === `/ide/${copyId}/__devspace/presence`) {
    return presenceReport(req, res, copyId);
  }
  if (url.pathname === `/ide/${copyId}/__devspace/review-findings`) {
    return reviewFindings(req, res, copyId);
  }
  plain(res, 404);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  // Only origin-form request targets ("/path?query"); nothing absolute, nothing else.
  if (!raw.startsWith('/')) return plain(res, 404);
  const url = new URL(raw, env.IDE_ORIGIN);
  if (url.pathname === '/ide-launch') return launch(req, res, url);

  const parsed = parseIdePath(raw);
  if (!parsed) return plain(res, 404);
  if (parsed.bare) {
    // Same answer for every well-formed id, so it reveals nothing.
    res.writeHead(308, {
      location: `/ide/${parsed.copyId}/${url.search}`,
      'content-length': 0,
      'content-security-policy': frameAncestors(),
    });
    res.end();
    return;
  }
  if (isDevspacePath(url.pathname, parsed.copyId)) {
    return devspacePath(req, res, url, parsed.copyId);
  }
  const copy = await cookieCopy(req, parsed.copyId);
  if (!copy) return plain(res, 404);
  if (copy.containerStatus !== 'running') return plain(res, 503);
  const target = await getIdeTarget(copy.id);
  if (!target) return plain(res, 503);
  recordIdeActivity(copy.id);

  const upstream = http.request({
    host: target.ip,
    port: CONTAINER_PORT,
    method: req.method,
    path: raw,
    headers: forwardHeaders(req.headers, target.token),
  });
  upstream.on('response', (answer) => {
    res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
    answer.pipe(res);
  });
  upstream.on('error', () => {
    forgetIdeTarget(copy.id);
    if (!res.headersSent) plain(res, 502);
    else res.destroy();
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

// ---------- WebSockets ----------

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
  const path = (req.url ?? '').split('?', 1)[0]!;
  if (isDevspacePath(path, parsed.copyId)) return refuse(socket, 404);
  // Only VS Code's own page on the IDE site may open its WebSockets.
  if (req.headers.origin !== env.IDE_ORIGIN) return refuse(socket, 403);
  const copy = await cookieCopy(req, parsed.copyId);
  if (!copy) return refuse(socket, 404);
  if (copy.containerStatus !== 'running') return refuse(socket, 503);
  const target = await getIdeTarget(copy.id);
  if (!target) return refuse(socket, 503);
  if (socket.destroyed) return;
  recordIdeActivity(copy.id);

  const upstream = net.connect(CONTAINER_PORT, target.ip);
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

/** The IDE site's HTTP server (not listening yet). */
export function createIdeServer(): Server {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error('IDE request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) plain(res, 502);
      else res.destroy();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error('IDE WebSocket failed:', err instanceof Error ? err.message : err);
      refuse(socket, 502);
    });
  });
  return server;
}
