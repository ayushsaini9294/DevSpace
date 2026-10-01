import { createSign } from 'node:crypto';
import type { GithubConfig } from './config.ts';

/**
 * GitHub's HTTP APIs (Phase 13): the app's user authorization (code exchange and refresh), the
 * REST calls DevSpace makes, and installation tokens minted from the app's private key. Every
 * call has a timeout and never follows a redirect. Tokens only travel in headers or in the
 * token endpoint's body; nothing here logs a token, and GitHub's messages are scrubbed of
 * anything token-like before they are shown.
 */

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const API_VERSION = '2022-11-28';

let timeoutMs = TIMEOUT_MS;

/** Tests: a shorter timeout. */
export function useGithubTimeout(ms: number | null): void {
  timeoutMs = ms ?? TIMEOUT_MS;
}

export type GithubFailure = 'http' | 'timeout' | 'network' | 'redirect' | 'bad_response' | 'oauth';

export class GithubApiError extends Error {
  constructor(
    readonly kind: GithubFailure,
    /** HTTP status for `http`, else null. */
    readonly status: number | null,
    /** GitHub's own message (scrubbed, ≤ 300 characters), or ''. For `oauth`: the error code. */
    readonly providerMessage: string,
    /** For a 422: the `errors[].message` texts. */
    readonly details: string[] = [],
  ) {
    super(
      kind === 'http'
        ? `GitHub answered ${status}${providerMessage ? `: ${providerMessage}` : ''}`
        : kind === 'oauth'
          ? `GitHub refused the sign-in (${providerMessage})`
          : kind === 'timeout'
            ? 'GitHub did not answer in time'
            : kind === 'redirect'
              ? 'GitHub answered with a redirect (not followed)'
              : kind === 'network'
                ? 'Could not reach GitHub'
                : 'GitHub sent an answer DevSpace could not read',
    );
    this.name = 'GithubApiError';
  }
}

/** Removes anything that looks like a GitHub token from text we may store or show. */
export function scrubGithub(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{6,}/g, '[token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{6,}/g, '[token]')
    .replace(/(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/\p{Cc}/gu, ' ');
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
      throw new GithubApiError('bad_response', null, '');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface RawAnswer {
  status: number;
  json: unknown;
}

async function send(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<RawAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    text = await readLimited(res);
  } catch (err) {
    if (err instanceof GithubApiError) throw err;
    throw new GithubApiError(controller.signal.aborted ? 'timeout' : 'network', null, '');
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    throw new GithubApiError('redirect', res.status, '');
  }
  let json: unknown = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok) throw new GithubApiError('bad_response', null, '');
    }
  }
  return { status: res.status, json };
}

function messageOf(json: unknown): { message: string; details: string[] } {
  if (typeof json !== 'object' || json === null) return { message: '', details: [] };
  const m = (json as { message?: unknown }).message;
  const errors = (json as { errors?: unknown }).errors;
  const details = Array.isArray(errors)
    ? errors
        .map((e) =>
          typeof e === 'string'
            ? e
            : typeof e === 'object' &&
                e !== null &&
                typeof (e as { message?: unknown }).message === 'string'
              ? (e as { message: string }).message
              : '',
        )
        .filter(Boolean)
        .map((d) => scrubGithub(d).slice(0, 300))
    : [];
  return { message: typeof m === 'string' ? scrubGithub(m).trim().slice(0, 300) : '', details };
}

/** One REST call with a bearer token. Non-2xx → GithubApiError('http'). */
export async function rest<T = unknown>(
  c: GithubConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'DevSpace',
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const answer = await send(`${c.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (answer.status < 200 || answer.status >= 300) {
    // 304 Not Modified counts as success for PUTs that change nothing.
    if (answer.status === 304) return { status: 304, data: null as T };
    const { message, details } = messageOf(answer.json);
    throw new GithubApiError('http', answer.status, message, details);
  }
  return { status: answer.status, data: answer.json as T };
}

// ---------- The app's user authorization ----------

export interface UserTokens {
  accessToken: string;
  /** Null when the app's tokens don't expire. */
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

function readTokens(json: unknown, now: number): UserTokens {
  if (typeof json !== 'object' || json === null) throw new GithubApiError('bad_response', null, '');
  const o = json as Record<string, unknown>;
  if (typeof o.error === 'string') {
    throw new GithubApiError('oauth', null, scrubGithub(o.error).slice(0, 100));
  }
  if (typeof o.access_token !== 'string' || o.access_token === '') {
    throw new GithubApiError('bad_response', null, '');
  }
  const seconds = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(now + v * 1000) : null;
  return {
    accessToken: o.access_token,
    accessTokenExpiresAt: seconds(o.expires_in),
    refreshToken: typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : null,
    refreshTokenExpiresAt: seconds(o.refresh_token_expires_in),
  };
}

async function tokenRequest(c: GithubConfig, body: Record<string, string>): Promise<UserTokens> {
  const now = Date.now();
  const answer = await send(`${c.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'DevSpace',
    },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  if (answer.status !== 200) {
    const { message } = messageOf(answer.json);
    throw new GithubApiError('http', answer.status, message);
  }
  return readTokens(answer.json, now);
}

/** GitHub's authorize page for the app's user authorization (PKCE S256). */
export function authorizeUrl(
  c: GithubConfig,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${c.webUrl}/login/oauth/authorize?${params.toString()}`;
}

export function exchangeCode(
  c: GithubConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<UserTokens> {
  return tokenRequest(c, { code, code_verifier: verifier, redirect_uri: redirectUri });
}

export function refreshTokens(c: GithubConfig, refreshToken: string): Promise<UserTokens> {
  return tokenRequest(c, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// ---------- The app itself (JWT) and installation tokens ----------

/** A short-lived JWT for the app (RS256, iss = app id, 9 minutes, backdated 60 s). */
export function appJwt(c: GithubConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: seconds - 60, exp: seconds + 540, iss: c.appId });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(c.privateKey).toString('base64url')}`;
}

/**
 * Mints an installation token limited to one repository and the given contents access. Never
 * stored: used for one push or clone and dropped.
 */
export async function installationToken(
  c: GithubConfig,
  installationId: string,
  repoId: string,
  contents: 'read' | 'write',
): Promise<string> {
  const { data } = await rest<{ token?: unknown }>(
    c,
    'POST',
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt(c),
    { repository_ids: [Number(repoId)], permissions: { contents } },
  );
  if (typeof data?.token !== 'string' || data.token === '') {
    throw new GithubApiError('bad_response', null, '');
  }
  return data.token;
}

// ---------- Shapes we read ----------

export interface GhUser {
  id: number;
  login: string;
}

export interface GhRepo {
  id: number;
  full_name: string;
  private: boolean;
  html_url?: string;
  default_branch?: string;
  size?: number;
  owner?: { login?: string; id?: number };
}

export interface GhInstallation {
  id: number;
  account?: { login?: string; id?: number } | null;
  repository_selection?: 'all' | 'selected';
}

export function isUser(v: unknown): v is GhUser {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as GhUser).id === 'number' &&
    typeof (v as GhUser).login === 'string'
  );
}

export function isRepo(v: unknown): v is GhRepo {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as GhRepo).id === 'number' &&
    typeof (v as GhRepo).full_name === 'string' &&
    /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test((v as GhRepo).full_name) &&
    typeof (v as GhRepo).private === 'boolean'
  );
}

/** Reads every page (100 per page, at most 20 pages) of a list endpoint. */
export async function listAll<T>(
  c: GithubConfig,
  path: string,
  token: string,
  pick: (data: unknown) => unknown[],
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await rest(c, 'GET', `${path}${sep}per_page=100&page=${page}`, token);
    const items = pick(data);
    out.push(...(items as T[]));
    if (items.length < 100) break;
  }
  return out;
}
