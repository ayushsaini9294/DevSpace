import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  AI_GATEWAY_MAX_BODY_BYTES,
  AI_GATEWAY_MAX_CONCURRENT,
  AI_GATEWAY_MAX_PER_MINUTE,
  AI_GATEWAY_TIMEOUT_MS,
  AiModelIdSchema,
  type AiGatewayErrorCode,
} from '@devspace/shared';
import { env } from '../config/env.ts';
import { getIdeTarget } from '../ide/service.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { aiAssistantBlocker, countAiGatewayRequest, hashAiGatewayToken } from './assistant.ts';
import { listModels, userKey } from './connection.ts';
import { isFreeModelId, openRouterBase, scrub } from './openrouter.ts';

/**
 * The AI gateway (Phase 12): the only way an IDE's built-in assistant reaches a model. It runs
 * on its own listener, bound only to the IDE network's host address. A container proves which
 * copy it is with that copy's gateway token AND by calling from that copy's container IP. The
 * gateway then adds the copy owner's real OpenRouter key (which never enters a container) and
 * passes the request through to OpenRouter unchanged, streaming the answer back as it comes.
 *
 * Nothing here logs a key, a prompt or an answer. Only daily request counts are kept.
 */

/** Limits (tests may shrink them with useAiGatewayLimits). */
const limits = {
  maxBodyBytes: AI_GATEWAY_MAX_BODY_BYTES,
  maxConcurrent: AI_GATEWAY_MAX_CONCURRENT,
  perMinute: AI_GATEWAY_MAX_PER_MINUTE,
  timeoutMs: AI_GATEWAY_TIMEOUT_MS,
};

/** Tests only: other limits (the rest stay as they are). */
export function useAiGatewayLimits(partial: Partial<typeof limits>): void {
  if (env.NODE_ENV !== 'test') throw new Error('useAiGatewayLimits is for tests only');
  Object.assign(limits, partial);
}

/** Tests only: back to the contract's limits, with no requests counted. */
export function resetAiGatewayLimits(): void {
  Object.assign(limits, {
    maxBodyBytes: AI_GATEWAY_MAX_BODY_BYTES,
    maxConcurrent: AI_GATEWAY_MAX_CONCURRENT,
    perMinute: AI_GATEWAY_MAX_PER_MINUTE,
    timeoutMs: AI_GATEWAY_TIMEOUT_MS,
  });
  active.clear();
  recent.clear();
}

/** Requests in flight, and start times in the last minute, per copy. */
const active = new Map<string, number>();
const recent = new Map<string, number[]>();

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  405: 'invalid_request_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
};

/** An OpenAI-style error body with a message the assistant shows to the member. */
function sendError(
  res: ServerResponse,
  status: number,
  code: AiGatewayErrorCode,
  message: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    error: { message, type: ERROR_TYPES[status] ?? 'api_error', code },
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MESSAGES = {
  invalid_token:
    "DevSpace doesn't recognise this IDE's AI access. Close the IDE and open it again from DevSpace, then try again.",
  not_member:
    'The owner of this copy is no longer a member of the project, so the AI assistant is off here.',
  ai_disabled: 'AI is switched off in this project. A leader can turn it on in Settings.',
  not_connected: 'Connect OpenRouter in DevSpace → AI settings first.',
  notice_required: 'Open DevSpace → AI settings and accept the AI notice first.',
  too_many_requests:
    'Too many AI requests from this IDE (at most 2 at once and 30 a minute). Wait a moment and try again.',
  request_too_large: 'This request is too big for the AI assistant (over 4 MB). Try a smaller one.',
  upstream_error: "DevSpace couldn't reach the AI service (OpenRouter). Try again in a moment.",
  upstream_timeout: "The AI service didn't finish in time (5 minutes). Try a smaller request.",
  internal_error: 'Something went wrong in DevSpace. Try again in a moment.',
} as const;

/** The caller's address as IPv4 when it is one (Node may show `::ffff:10.213.0.5`). */
function clientIp(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

interface GatewayCopy {
  copyId: string;
  projectId: string;
  ownerId: string;
}

/** The copy whose token this is, when the request also comes from that copy's container. */
async function authenticate(req: IncomingMessage): Promise<GatewayCopy | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '');
  if (!match) return null;
  const row = await prisma.copy.findUnique({
    where: { aiGatewayTokenHash: hashAiGatewayToken(match[1]!) },
    select: { id: true, projectId: true, userId: true, containerStatus: true },
  });
  if (!row || (row.containerStatus !== 'running' && row.containerStatus !== 'starting')) {
    return null;
  }
  let ip: string | undefined;
  try {
    ip = (await getIdeTarget(row.id))?.ip;
  } catch {
    ip = undefined; // Docker can't say: refuse
  }
  if (!ip || ip !== clientIp(req)) return null;
  return { copyId: row.id, projectId: row.projectId, ownerId: row.userId };
}

/** Takes a slot for this copy, or false when it is over its limits. */
function takeSlot(copyId: string): boolean {
  const now = Date.now();
  const starts = (recent.get(copyId) ?? []).filter((t) => now - t < 60_000);
  const running = active.get(copyId) ?? 0;
  if (starts.length >= limits.perMinute || running >= limits.maxConcurrent) {
    recent.set(copyId, starts);
    return false;
  }
  starts.push(now);
  recent.set(copyId, starts);
  active.set(copyId, running + 1);
  return true;
}

function releaseSlot(copyId: string): void {
  const running = (active.get(copyId) ?? 1) - 1;
  if (running > 0) active.set(copyId, running);
  else active.delete(copyId);
}

type Refusal = { status: number; code: AiGatewayErrorCode; message: string };

/** The checks on every request: membership, the project switch, connection, notice. */
async function refusalFor(copy: GatewayCopy): Promise<Refusal | null> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: copy.projectId, userId: copy.ownerId } },
    select: { userId: true },
  });
  if (!member) return { status: 403, code: 'not_member', message: MESSAGES.not_member };
  const blocker = await aiAssistantBlocker(copy.projectId, copy.ownerId);
  if (blocker) return { status: 403, code: blocker, message: MESSAGES[blocker] };
  return null;
}

async function allowsPaid(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiAllowPaid: true },
  });
  return user?.aiAllowPaid ?? false;
}

class BodyTooLarge extends Error {}

/**
 * The request body, at most `limits.maxBodyBytes`. Past the limit it rejects with BodyTooLarge
 * and the rest is read and dropped, so the caller still gets the 413 answer.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limits.maxBodyBytes;
    if (tooLarge) {
      reject(new BodyTooLarge());
      return; // Node drops the unread body once the answer is sent
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (buf: Buffer) => {
      if (tooLarge) return;
      size += buf.length;
      if (size > limits.maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new Error('request aborted'));
    });
  });
}

/** GET /v1/models: the models this copy's owner may use, in OpenAI's list shape. */
async function sendModels(res: ServerResponse, copy: GatewayCopy): Promise<void> {
  const [models, paid] = await Promise.all([listModels(), allowsPaid(copy.ownerId)]);
  const data = models
    .filter((m) => paid || isFreeModelId(m.id))
    .map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
      name: m.name,
      context_length: m.contextLength,
    }));
  const body = JSON.stringify({ object: 'list', data });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Largest error body read from OpenRouter before passing it on. */
const MAX_UPSTREAM_ERROR_BYTES = 256 * 1024;

async function readErrorBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UPSTREAM_ERROR_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only these of OpenRouter's response headers reach the container. */
const PASSED_RESPONSE_HEADERS = ['content-type', 'cache-control'];

/** POST /v1/chat/completions: checks the model, then passes the request through. */
async function forwardChat(
  req: IncomingMessage,
  res: ServerResponse,
  copy: GatewayCopy,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      sendError(res, 413, 'request_too_large', MESSAGES.request_too_large);
    } else res.destroy();
    return;
  }
  let model: string;
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    request = parsed as Record<string, unknown>;
    model = AiModelIdSchema.parse(request.model);
  } catch {
    sendError(
      res,
      400,
      'invalid_request',
      'The AI request must be JSON with a model id (for example "qwen/qwen3.8-27b:free").',
    );
    return;
  }
  // Everything in the request that could spend credits, not only `model`: OpenRouter's
  // `models` fallback list, and plugins such as web search (paid even with a free model).
  const fallbacks = Array.isArray(request.models) ? request.models : [];
  const spendsCredits =
    !isFreeModelId(model) ||
    (request.models !== undefined && !Array.isArray(request.models)) ||
    fallbacks.some((m) => typeof m !== 'string' || !isFreeModelId(m)) ||
    request.plugins !== undefined ||
    request.web_search_options !== undefined ||
    request.preset !== undefined;
  if (spendsCredits && !(await allowsPaid(copy.ownerId))) {
    sendError(
      res,
      403,
      'paid_model_not_allowed',
      isFreeModelId(model)
        ? 'This request uses paid options (other models to fall back to, or plugins such as web search). Use free models only, or switch on "Allow paid models" in DevSpace → AI settings (it uses your OpenRouter credits).'
        : `The model "${model}" isn't free. Pick a free model (its id ends in ":free"), or switch on "Allow paid models" in DevSpace → AI settings (it uses your OpenRouter credits).`,
    );
    return;
  }
  const key = await userKey(copy.ownerId);
  if (!key) {
    sendError(res, 403, 'not_connected', MESSAGES.not_connected);
    return;
  }

  const accept = req.headers.accept;
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: typeof accept === 'string' && /^[\w/+.*,;= -]{1,200}$/.test(accept) ? accept : '*/*',
    // OpenRouter's optional app attribution headers.
    'http-referer': env.APP_ORIGIN,
    'x-title': 'DevSpace',
  };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  // The assistant gave up (closed the connection): stop asking OpenRouter too.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    let upstream: Response;
    try {
      upstream = await fetch(`${openRouterBase()}/api/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (timedOut) sendError(res, 504, 'upstream_timeout', MESSAGES.upstream_timeout);
      else if (!res.destroyed) sendError(res, 502, 'upstream_error', MESSAGES.upstream_error);
      return;
    }
    if (upstream.type === 'opaqueredirect' || (upstream.status >= 300 && upstream.status < 400)) {
      await upstream.body?.cancel().catch(() => undefined);
      sendError(res, 502, 'upstream_error', MESSAGES.upstream_error);
      return;
    }
    const outHeaders: Record<string, string> = { 'cache-control': 'no-store' };
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    if (!upstream.ok) {
      // OpenRouter's own error (e.g. 429 rate limit), passed on with anything key-like removed.
      let text: string;
      try {
        text = scrub(await readErrorBody(upstream.body), key);
      } catch {
        if (timedOut) sendError(res, 504, 'upstream_timeout', MESSAGES.upstream_timeout);
        else if (!res.destroyed) sendError(res, 502, 'upstream_error', MESSAGES.upstream_error);
        return;
      }
      res.writeHead(upstream.status, outHeaders);
      res.end(text);
      return;
    }
    void countAiGatewayRequest(copy.ownerId, model);
    res.writeHead(upstream.status, outHeaders);
    res.flushHeaders();
    if (!upstream.body) {
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), res);
    } catch {
      // OpenRouter or the assistant dropped the stream (or the timeout hit): end it here.
      res.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://gateway').pathname.replace(/\/+$/, '');
  const route = path === '/v1/chat/completions' ? 'chat' : path === '/v1/models' ? 'models' : null;
  if (!route) {
    sendError(res, 404, 'not_found', 'Not found. The AI gateway serves only /v1.');
    return;
  }
  const method = route === 'chat' ? 'POST' : 'GET';
  if (req.method !== method) {
    res.setHeader('allow', method);
    sendError(res, 405, 'method_not_allowed', `Use ${method} for ${path}.`);
    return;
  }
  const copy = await authenticate(req);
  if (!copy) {
    sendError(res, 401, 'invalid_token', MESSAGES.invalid_token);
    return;
  }
  if (!takeSlot(copy.copyId)) {
    sendError(res, 429, 'too_many_requests', MESSAGES.too_many_requests);
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot(copy.copyId);
  };
  res.on('close', release);
  try {
    const refusal = await refusalFor(copy);
    if (refusal) {
      sendError(res, refusal.status, refusal.code, refusal.message);
      return;
    }
    if (route === 'models') await sendModels(res, copy);
    else await forwardChat(req, res, copy);
  } finally {
    if (res.writableFinished || res.destroyed) release();
  }
}

/** The gateway's HTTP server (not listening yet). */
export function createAiGatewayServer(): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // The message only: never a request body or a key.
      console.error(
        'AI gateway request failed:',
        err instanceof Error ? err.message : 'unknown error',
      );
      if (!res.headersSent) {
        // listModels throws 502 `openrouter_error` when OpenRouter can't be reached.
        if (err instanceof HttpError && err.body.error === 'openrouter_error')
          sendError(res, 502, 'upstream_error', MESSAGES.upstream_error);
        else sendError(res, 500, 'internal_error', MESSAGES.internal_error);
      } else res.destroy();
    });
  });
  server.headersTimeout = 30_000;
  // Receiving the (≤ 4 MB) request may take a while on a slow link, never 5 minutes.
  server.requestTimeout = 120_000;
  return server;
}

/** Listens on exactly `host:port` (never all addresses). Rejects with the socket error. */
export function listenAiGateway(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** How often to try again while the gateway's address or port isn't available. */
export const AI_GATEWAY_RETRY_MS = 30_000;

export interface RunningAiGateway {
  server: http.Server;
  /** Resolves when the gateway is listening (never rejects; it keeps retrying). */
  listening: Promise<void>;
  close(): void;
}

/**
 * Starts the gateway on AI_GATEWAY_HOST:AI_GATEWAY_PORT. If that address doesn't exist yet (the
 * devspace-ide network wasn't created) or the port is taken, it says so in the log and tries
 * again every 30 s; the rest of the API keeps running either way.
 */
export function startAiGateway(
  options: { host?: string; port?: number; retryMs?: number } = {},
): RunningAiGateway {
  const host = options.host ?? env.AI_GATEWAY_HOST;
  const port = options.port ?? env.AI_GATEWAY_PORT;
  const retryMs = options.retryMs ?? AI_GATEWAY_RETRY_MS;
  const server = createAiGatewayServer();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let warned = false;
  const listening = new Promise<void>((resolve) => {
    const attempt = () => {
      if (closed) return;
      listenAiGateway(server, host, port).then(
        () => {
          console.log(`AI gateway listening on ${host}:${port} (for IDE containers only)`);
          resolve();
        },
        (err: NodeJS.ErrnoException) => {
          if (!warned) {
            warned = true;
            const why =
              err.code === 'EADDRNOTAVAIL'
                ? `the address ${host} doesn't exist on this machine (create the IDE network: npm run ide:network)`
                : err.code === 'EADDRINUSE'
                  ? `port ${port} on ${host} is already in use`
                  : `${err.code ?? ''} ${err.message}`.trim();
            console.error(
              `AI gateway not started: ${why}. The IDE's AI assistant won't work until it is; ` +
                `retrying every ${Math.round(retryMs / 1000)} s. Everything else keeps working.`,
            );
          }
          timer = setTimeout(attempt, retryMs);
          timer.unref();
        },
      );
    };
    attempt();
  });
  return {
    server,
    listening,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
  };
}
