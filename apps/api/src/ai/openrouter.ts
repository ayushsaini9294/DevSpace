import type { AiModel, FreeRequests } from '@devspace/shared';
import { env } from '../config/env.ts';

/**
 * OpenRouter's HTTP API (Phase 10). Every call goes to OPENROUTER_BASE_URL (tests point it at a
 * stand-in server), has a timeout, and never follows a redirect. Keys only ever travel in the
 * Authorization header; nothing here logs a key, and error messages taken from OpenRouter have
 * anything key-like removed before they are stored or shown.
 */

let baseUrl = env.OPENROUTER_BASE_URL;

/** Timeouts in ms: short calls (keys, models) and chat completions. */
const timeouts = { short: 15_000, chat: 60_000 };

/** Tests: another base URL (a local stand-in) and shorter timeouts. */
export function useOpenRouter(options: { baseUrl?: string; shortMs?: number; chatMs?: number }) {
  if (options.baseUrl !== undefined) baseUrl = options.baseUrl;
  if (options.shortMs !== undefined) timeouts.short = options.shortMs;
  if (options.chatMs !== undefined) timeouts.chat = options.chatMs;
}

export function openRouterBase(): string {
  return baseUrl;
}

/** Largest answer body read from OpenRouter. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type OpenRouterFailure = 'http' | 'timeout' | 'network' | 'redirect' | 'bad_response';

export class OpenRouterError extends Error {
  constructor(
    readonly kind: OpenRouterFailure,
    /** HTTP status for `http`, else null. */
    readonly status: number | null,
    /** OpenRouter's own message (key-like text removed, ≤ 300 characters), or ''. */
    readonly providerMessage: string,
  ) {
    super(
      kind === 'http'
        ? `OpenRouter answered ${status}${providerMessage ? `: ${providerMessage}` : ''}`
        : kind === 'timeout'
          ? 'OpenRouter did not answer in time'
          : kind === 'redirect'
            ? 'OpenRouter answered with a redirect (not followed)'
            : kind === 'network'
              ? 'Could not reach OpenRouter'
              : 'OpenRouter sent an answer DevSpace could not read',
    );
    this.name = 'OpenRouterError';
  }
}

/** Removes anything that looks like a key or bearer token from text we may store or show. */
export function scrub(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join('[key]');
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\t' ? c : ' '));
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OpenRouterError('bad_response', null, '');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function providerMessage(body: unknown, key?: string): string {
  let message = '';
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') message = error;
    else if (typeof error === 'object' && error !== null) {
      const m = (error as { message?: unknown }).message;
      if (typeof m === 'string') message = m;
    }
  }
  return scrub(message, key).trim().slice(0, 300);
}

interface CallOptions {
  method: 'GET' | 'POST';
  key?: string;
  body?: unknown;
  timeoutMs: number;
}

async function call(path: string, options: CallOptions): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    // OpenRouter's optional app attribution headers.
    'http-referer': env.APP_ORIGIN,
    'x-title': 'DevSpace',
  };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new OpenRouterError('timeout', null, '');
    }
    throw new OpenRouterError('network', null, '');
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => undefined);
    throw new OpenRouterError('redirect', res.status, '');
  }
  let text: string;
  try {
    text = await readLimited(res);
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    const name = (err as { name?: string } | null)?.name;
    throw new OpenRouterError(name === 'TimeoutError' ? 'timeout' : 'network', null, '');
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new OpenRouterError('http', res.status, providerMessage(json, options.key));
  if (json === null) throw new OpenRouterError('bad_response', res.status, '');
  return json;
}

/** The page the browser goes to for OpenRouter's login (PKCE, S256). */
export function authUrl(callbackUrl: string, codeChallenge: string): string {
  const url = new URL('/auth', baseUrl);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** POST /api/v1/auth/keys: the login code for a key. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const json = await call('/api/v1/auth/keys', {
    method: 'POST',
    body: { code, code_verifier: verifier, code_challenge_method: 'S256' },
    timeoutMs: timeouts.short,
  });
  const key = (json as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length < 8 || key.length > 500) {
    throw new OpenRouterError('bad_response', 200, '');
  }
  return key;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** GET /api/v1/key: today's free-model requests (null when OpenRouter doesn't say). */
export async function freeRequestsToday(key: string): Promise<FreeRequests | null> {
  const json = await call('/api/v1/key', { method: 'GET', key, timeoutMs: timeouts.short });
  const data = (json as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const free = (data as { free_model_daily_requests?: unknown }).free_model_daily_requests;
  if (typeof free !== 'object' || free === null) return null;
  const f = free as Record<string, unknown>;
  const used = count(f.used);
  const limit = count(f.limit);
  if (used === null || limit === null) return null;
  const remaining = count(f.remaining) ?? Math.max(0, limit - used);
  return { used, limit, remaining };
}

/** A model id is free when it ends in `:free` or is OpenRouter's free router. */
export function isFreeModelId(id: string): boolean {
  return id.endsWith(':free') || id === 'openrouter/free';
}

function isZeroPrice(value: unknown): boolean {
  return (typeof value === 'string' || typeof value === 'number') && Number(value) === 0;
}

/** GET /api/v1/models: every model, with `isFree`. */
export async function fetchModels(): Promise<AiModel[]> {
  const json = await call('/api/v1/models', { method: 'GET', timeoutMs: timeouts.short });
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new OpenRouterError('bad_response', 200, '');
  const models: AiModel[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || !/^[A-Za-z0-9._~:/-]{1,200}$/.test(m.id)) continue;
    const pricing = (
      typeof m.pricing === 'object' && m.pricing !== null ? m.pricing : {}
    ) as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.slice(0, 200) : m.id;
    models.push({
      id: m.id,
      name,
      isFree:
        isFreeModelId(m.id) || (isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion)),
      contextLength: count(m.context_length),
    });
  }
  return models;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** POST /api/v1/chat/completions: the answer's text ('' when empty) and the model that answered. */
export async function chat(
  key: string,
  model: string,
  messages: ChatMessage[],
): Promise<{ content: string; model: string }> {
  const json = await call('/api/v1/chat/completions', {
    method: 'POST',
    key,
    body: { model, messages, temperature: 0.2 },
    timeoutMs: timeouts.chat,
  });
  const choices = (json as { choices?: unknown }).choices;
  const first = Array.isArray(choices)
    ? (choices[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = first?.message as { content?: unknown } | undefined;
  const content = typeof message?.content === 'string' ? message.content : '';
  // Some providers put an error inside a 200 answer.
  const error = (json as { error?: unknown }).error;
  if (!content && error) {
    const code = (error as { code?: unknown }).code;
    const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 502;
    throw new OpenRouterError('http', status, providerMessage(json, key));
  }
  return { content, model };
}
