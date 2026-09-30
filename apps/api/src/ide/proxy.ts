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
import { isPreviewPort, MAX_IDE_FINDINGS_BYTES, PresenceReportSchema } from '@devspace/shared';
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
import { forgetIdeTarget, getIdeTarget, recordIdeActivity } from './service.ts';

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
  // A member's app must not wipe the IDE site's cookies or storage either (Phase 11 Preview).
  'clear-site-data',
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

/**
 * What the container receives: the request's headers minus credentials, plus VS Code's token
 * (null for a Preview request: the member's own app never gets any cookie or token).
 */
export function forwardHeaders(
  headers: IncomingHttpHeaders,
  token: string | null,
): OutgoingHttpHeaders {
  const listed = connectionListed(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  if (token !== null) out.cookie = `vscode-tkn=${token}`;
  return out;
}

/**
 * `/ide/<copyId>/__preview/<port>` (bare: no slash after the port) or `…/<port>/…`, for a port
 * a member's app may use (1024–65535 except 3000, written without leading zeros). Null when
 * the path isn't a preview path; `port: null` when it is one but the port isn't allowed.
 */
export function parsePreviewPath(
  pathname: string,
  copyId: string,
): { port: number | null; bare: boolean } | null {
  const prefix = `/ide/${copyId}/__preview/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const text = slash === -1 ? rest : rest.slice(0, slash);
  const port = /^[1-9][0-9]{0,4}$/.test(text) ? Number(text) : NaN;
  return { port: isPreviewPort(port) ? port : null, bare: slash === -1 };
}

/** The allow-list for /ide-launch's `next`: only `__preview/<allowed port>/`. */
export function previewNext(next: string): string | null {
  const match = /^__preview\/([1-9][0-9]{0,4})\/$/.exec(next);
  return match && isPreviewPort(Number(match[1])) ? next : null;
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

/** The Preview page when nothing answers on the port (Phase 11). */
function nothingRunning(port: number): string {
  return `Nothing is running on port ${port} yet. Start your app in the IDE terminal (see README).`;
}

function plain(res: ServerResponse, status: number, message?: string): void {
  const body = `${message ?? PLAIN_MESSAGES[status] ?? STATUS_CODES[status] ?? ''}\n`;
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
  // Where to land inside the copy's path: the IDE, or (Phase 11) one preview port. Anything
  // else is refused before the ticket is used up.
  const rawNext = url.searchParams.get('next');
  const next = rawNext === null ? '' : previewNext(rawNext);
  if (next === null) return plain(res, 404);
  const ticket = url.searchParams.get('ticket');
  const session = ticket ? await redeemTicket(ticket) : null;
  if (!session) return plain(res, 404);
  const cookies = [ideCookieHeader(session.cookieValue, session.copyId)];
  const target = await getIdeTarget(session.copyId);
  if (target) cookies.push(vscodeTokenCookieHeader(target.token, session.copyId));
  res.writeHead(303, {
    location: `/ide/${session.copyId}/${next}`,
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
  const preview = parsePreviewPath(url.pathname, parsed.copyId);
  // A port nobody may preview (3000 is VS Code itself, or out of range): the same plain 404.
  if (preview && preview.port === null) return plain(res, 404);
  const copy = await cookieCopy(req, parsed.copyId);
  if (!copy) return plain(res, 404);
  if (preview?.bare) {
    res.writeHead(308, {
      location: `${url.pathname}/${url.search}`,
      'content-length': 0,
      'content-security-policy': frameAncestors(),
    });
    res.end();
    return;
  }
  if (copy.containerStatus !== 'running') return plain(res, 503);
  const target = await getIdeTarget(copy.id);
  if (!target) return plain(res, 503);
  recordIdeActivity(copy.id);
  const port = preview?.port ?? CONTAINER_PORT;

  const upstream = http.request({
    host: target.ip,
    port,
    method: req.method,
    // The full path: the templates are built to be served under their preview path.
    path: raw,
    headers: forwardHeaders(req.headers, preview ? null : target.token),
  });
  let connectTimer: NodeJS.Timeout | undefined;
  if (preview) {
    // A port nobody listens on is usually refused at once; this covers a silent drop too.
    connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), 10_000);
    upstream.on('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });
  }
  upstream.on('response', (answer) => {
    clearTimeout(connectTimer);
    res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
    answer.pipe(res);
  });
  upstream.on('error', () => {
    clearTimeout(connectTimer);
    if (preview) {
      if (!res.headersSent) plain(res, 502, nothingRunning(port));
      else res.destroy();
      return;
    }
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

/**
 * The upgrade request as the container sees it: same line, filtered headers, and VS Code's
 * token (never for a Preview, whose app gets no credentials).
 */
function upgradeRequest(req: IncomingMessage, token: string | null): string {
  const headers = forwardHeaders(req.headers, token);
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
  const preview = parsePreviewPath(path, parsed.copyId);
  if (preview && (preview.port === null || preview.bare)) return refuse(socket, 404);
  // Only pages on the IDE site (VS Code, or a Preview of the member's app, e.g. Vite's live
  // reload) may open these WebSockets.
  if (req.headers.origin !== env.IDE_ORIGIN) return refuse(socket, 403);
  const copy = await cookieCopy(req, parsed.copyId);
  if (!copy) return refuse(socket, 404);
  if (copy.containerStatus !== 'running') return refuse(socket, 503);
  const target = await getIdeTarget(copy.id);
  if (!target) return refuse(socket, 503);
  if (socket.destroyed) return;
  recordIdeActivity(copy.id);

  const upstream = net.connect(preview?.port ?? CONTAINER_PORT, target.ip);
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    upstream.write(upgradeRequest(req, preview ? null : target.token));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on('data', () => recordIdeActivity(copy.id));
  });
  upstream.on('error', () => {
    if (preview) {
      // Nothing listening on that port: say so plainly instead of dropping the connection.
      if (!connected) refuse(socket, 502);
      else socket.destroy();
      return;
    }
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
