import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';

/** `<repo root>/.data/repos`, found from this file's location (src/config or dist/config), not the cwd. */
const DEFAULT_REPOS_DIR = fileURLToPath(new URL('../../../../.data/repos', import.meta.url));

/** `<repo root>/.data/copies`, found the same way. */
const DEFAULT_COPIES_DIR = fileURLToPath(new URL('../../../../.data/copies', import.meta.url));

/** An optional folder setting: relative paths resolve against the cwd; unset → `fallback`. */
const folder = (fallback: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? (isAbsolute(value) ? value : resolve(value)) : fallback));

/** An http(s) origin such as `https://app.example.com` (no path, query or trailing slash). */
const origin = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
      } catch {
        return false;
      }
    }, 'must be an origin like https://example.com (no path or trailing slash)');

/** A comma-separated list of OpenRouter model ids (empty items dropped). */
const modelList = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .refine(
      (list) => list.length > 0 && list.every((id) => /^[A-Za-z0-9._~:/-]{1,200}$/.test(id)),
      'must be a comma-separated list of model ids',
    );

/** A fixed key for NODE_ENV=test only (never used anywhere else). */
const TEST_AI_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The address the main listener (PORT) binds. Unset: every interface (development). In
     * production `127.0.0.1`, so only Caddy reaches it.
     */
    API_HOST: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || undefined),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Redis, for queueing jobs for the worker (the worker reads the same variable). */
    REDIS_URL: z.string().trim().min(1).default('redis://localhost:6379'),
    /** Where the projects' bare Git repositories live. Relative paths resolve against the cwd. */
    REPOS_DIR: folder(DEFAULT_REPOS_DIR),
    /** Where the members' working copies live: `<COPIES_DIR>/<projectId>/<copyId>`. */
    COPIES_DIR: folder(DEFAULT_COPIES_DIR),
    /** Docker's local socket. Docker is never reached over TCP. */
    DOCKER_SOCKET: z
      .string()
      .trim()
      .default('/var/run/docker.sock')
      .refine((value) => isAbsolute(value), 'DOCKER_SOCKET must be an absolute socket path'),
    /** The IDE image (built by `npm run ide:build`). */
    IDE_IMAGE: z.string().trim().min(1).default('devspace-ide:5'),
    /** The Docker network IDE containers join (made by `npm run ide:network`). */
    IDE_NETWORK: z.string().trim().min(1).default('devspace-ide'),
    /** The second listener, which serves only the IDE (its own site: never the app's cookies). */
    IDE_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    /** The address the IDE listener binds (IPv4 loopback by default, reachable from Windows). */
    IDE_HOST: z.string().trim().min(1).default('127.0.0.1'),
    /** The web app's public origin: the only page allowed to frame the IDE or POST to /api. */
    APP_ORIGIN: origin('http://localhost:5173'),
    /**
     * The IDE listener's public base address (Phase 14): scheme + base host + optional port, no
     * path. Each copy's IDE lives on its own origin `<scheme>://<copyId>.<base host>[:port]`
     * (see ide/origin.ts). In production it must be a different registrable domain from the app.
     */
    IDE_BASE_URL: origin('http://ide.localhost:3100'),
    /** The old single IDE origin (before Phase 14). Startup refuses while it is still set. */
    IDE_ORIGIN: z.string().optional(),
    /**
     * Express `trust proxy` (Phase 14): off by default. `loopback` behind Caddy on the same host;
     * also `true`, a hop count, or a comma-separated list of addresses/CIDRs. The IDE listener
     * uses the same setting for X-Forwarded-Proto.
     */
    TRUST_PROXY: z
      .string()
      .trim()
      .optional()
      .transform((value, ctx): boolean | number | string => {
        const v = (value ?? '').toLowerCase();
        if (v === '' || v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
        if (v === 'on' || v === 'true' || v === 'yes') return true;
        if (/^[1-9][0-9]{0,2}$/.test(v)) return Number(v);
        try {
          express().set('trust proxy', value);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: 'must be off, true, a hop count, loopback, or a list of addresses/CIDRs',
          });
          return z.NEVER;
        }
        return value!;
      }),
    /**
     * Rate limits: unset → on, except when NODE_ENV=test. `on` turns them on in tests; `off`
     * turns them off outside production (the e2e run, which uses development mode).
     */
    RATE_LIMITS: z.enum(['on', 'off']).optional(),
    /**
     * `1` lets APP_ORIGIN / IDE_BASE_URL use http:// in production, but only when both hosts are
     * `localhost` or `*.localhost` (the local proof of the production stack). Otherwise both
     * must be https.
     */
    ALLOW_HTTP_LOCALHOST: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === '1' || value === 'true'),
    /**
     * Encrypts stored AI keys (AES-256-GCM): 32 random bytes, base64 (`openssl rand -base64 32`).
     * Required outside tests; the API and the worker refuse to start without it.
     */
    AI_SECRETS_KEY: z.string().trim().optional(),
    /** Every OpenRouter call goes here (tests point it at a stand-in server). */
    OPENROUTER_BASE_URL: origin('https://openrouter.ai'),
    /** Models a cross-review uses when none are picked (Phase 10, owner decision). */
    AI_DEFAULT_MODELS: modelList(
      'qwen/qwen3.8-27b:free,nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free',
    ),
    /**
     * The AI gateway listener (Phase 12) binds only this address: the IDE network's gateway on
     * the host (bridge `br-dsp-ide`), so only IDE containers can reach it. IPv4 only.
     */
    AI_GATEWAY_HOST: z.ipv4().default('10.213.0.1'),
    AI_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    /**
     * GitHub (Phase 13): the DevSpace GitHub App. All optional; without the app's id, slug,
     * private key and client id/secret, every GitHub feature answers `github_not_configured`.
     */
    GITHUB_APP_ID: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'must be the numeric GitHub App ID')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    GITHUB_APP_SLUG: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,100}$/, 'must be the app’s URL slug')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** The app's private key (PEM file, outside the repository). Read when needed, never logged. */
    GITHUB_APP_PRIVATE_KEY_PATH: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? (isAbsolute(value) ? value : resolve(value)) : undefined)),
    GITHUB_CLIENT_ID: z.string().trim().max(200).optional(),
    GITHUB_CLIENT_SECRET: z.string().trim().max(500).optional(),
    /** GitHub's REST API (a GHES-style prefix such as `http://127.0.0.1:4020/api/v3` works). */
    GITHUB_API_URL: z.string().trim().default('https://api.github.com'),
    /** GitHub's web address: sign-in, app install pages and Git over HTTPS. */
    GITHUB_WEB_URL: z.string().trim().default('https://github.com'),
    /** `1` lets GITHUB_API_URL/GITHUB_WEB_URL use http:// (stand-in GitHub in e2e only). */
    GITHUB_ALLOW_HTTP: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === '1' || value === 'true'),
    /** Tried in order when a model fails (429, 5xx, timeout, empty answer). */
    AI_FALLBACK_MODELS: modelList(
      'poolside/laguna-s-2.1:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free',
    ),
  })
  .transform((e, ctx) => {
    const raw = e.AI_SECRETS_KEY || (e.NODE_ENV === 'test' ? TEST_AI_SECRETS_KEY : '');
    const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_SECRETS_KEY'],
        message: raw
          ? 'must be 32 bytes, base64-encoded (openssl rand -base64 32)'
          : 'is required (32 bytes, base64: openssl rand -base64 32)',
      });
      return z.NEVER;
    }
    return { ...e, AI_SECRETS_KEY: key };
  })
  .superRefine((e, ctx) => {
    // GitHub's addresses: https only (http only for a stand-in: NODE_ENV=test or GITHUB_ALLOW_HTTP),
    // no credentials, query or fragment.
    for (const key of ['GITHUB_API_URL', 'GITHUB_WEB_URL'] as const) {
      let ok: boolean;
      try {
        const url = new URL(e[key]);
        const httpOk = e.NODE_ENV === 'test' || e.GITHUB_ALLOW_HTTP;
        ok =
          (url.protocol === 'https:' || (httpOk && url.protocol === 'http:')) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash;
      } catch {
        ok = false;
      }
      if (!ok) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be an https:// address with no login, query or # part',
        });
      }
    }
  })
  .transform((e) => ({
    ...e,
    GITHUB_API_URL: e.GITHUB_API_URL.replace(/\/+$/, ''),
    GITHUB_WEB_URL: e.GITHUB_WEB_URL.replace(/\/+$/, ''),
  }))
  .superRefine((e, ctx) => {
    if (e.IDE_ORIGIN !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['IDE_ORIGIN'],
        message:
          'was renamed: remove IDE_ORIGIN and set IDE_BASE_URL instead (scheme + base host + port, ' +
          'e.g. http://ide.localhost:3100; each copy gets <copyId>.<base host>)',
      });
    }
    let app: URL;
    let ide: URL;
    try {
      app = new URL(e.APP_ORIGIN);
      ide = new URL(e.IDE_BASE_URL);
    } catch {
      return; // already reported by the field checks
    }
    if (ideHostUnderApp(app.hostname, ide.hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['IDE_BASE_URL'],
        message:
          "IDE_BASE_URL's host must not be APP_ORIGIN's host or under it (use a separate domain)",
      });
    }
    if (e.NODE_ENV === 'production') {
      // http is allowed only for the local proof: ALLOW_HTTP_LOCALHOST and BOTH hosts on
      // localhost / *.localhost (lead, 2026-10-06).
      const localProof =
        e.ALLOW_HTTP_LOCALHOST && isLocalhostName(app.hostname) && isLocalhostName(ide.hostname);
      for (const [key, url] of [
        ['APP_ORIGIN', app],
        ['IDE_BASE_URL', ide],
      ] as const) {
        if (url.protocol === 'https:' || localProof) continue;
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be https:// in production',
        });
      }
      // (A missing AI_SECRETS_KEY is refused above, outside tests.)
      if (e.RATE_LIMITS === 'off') {
        ctx.addIssue({
          code: 'custom',
          path: ['RATE_LIMITS'],
          message: 'cannot be off in production',
        });
      }
      if (usesDevPassword(e.DATABASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'uses the development password "devspace": set a strong database password',
        });
      }
    }
  });

/** `localhost` or a name under it (`*.localhost`), which browsers keep on this machine. */
function isLocalhostName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Whether the IDE base host is the app's host or under it (the same site, which could plant
 * cookies for the app). A bare `localhost` app host is a top-level name, so `*.localhost` names
 * are separate sites from it (the development setup: app `localhost`, IDEs `*.ide.localhost`).
 */
export function ideHostUnderApp(appHost: string, ideHost: string): boolean {
  if (appHost === ideHost) return true;
  if (appHost === 'localhost') return false;
  return ideHost.endsWith(`.${appHost}`);
}

/** Whether a postgres URL's password is the development one, `devspace`. */
function usesDevPassword(databaseUrl: string): boolean {
  try {
    return decodeURIComponent(new URL(databaseUrl).password) === 'devspace';
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof EnvSchema>;

/**
 * The environment without blank settings: `VAR=` (e.g. compose's `${VAR:-}`) means "not set",
 * so the default applies.
 */
export function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
}

/** Parses an environment (tests check refusals with this; the app uses `env`). */
export function parseEnv(
  source: NodeJS.ProcessEnv,
): { ok: true; env: Env } | { ok: false; issues: string[] } {
  const result = EnvSchema.safeParse(withoutBlanks(source));
  if (result.success) return { ok: true, env: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}

function loadEnv(): Env {
  const result = parseEnv(process.env);
  if (!result.ok) {
    throw new Error(
      `Invalid environment variables:\n${result.issues.map((issue) => `  ${issue}`).join('\n')}`,
    );
  }
  return result.env;
}

export const env = loadEnv();
