import { readFileSync } from 'node:fs';
import { env } from '../config/env.ts';
import { HttpError } from '../lib/http-error.ts';

/**
 * The DevSpace GitHub App's settings (Phase 13), from the environment. Every GitHub feature
 * checks `githubConfig()` first and answers `github_not_configured` when it is incomplete.
 * Secrets (the client secret and the private key) are never logged or sent anywhere but GitHub.
 */

export interface GithubConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM text of the app's private key. */
  privateKey: string;
  /** REST API base, no trailing slash (e.g. https://api.github.com). */
  apiUrl: string;
  /** Web base, no trailing slash (e.g. https://github.com). */
  webUrl: string;
  /** Plain http may be used (a stand-in GitHub in tests). */
  allowHttp: boolean;
}

type Override = Partial<GithubConfig> | null;

let override: Override = null;
let cachedKey: { path: string; pem: string } | null = null;

function privateKeyFromEnv(): string | null {
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!path) return null;
  if (cachedKey?.path === path) return cachedKey.pem;
  try {
    const pem = readFileSync(path, 'utf8');
    if (!pem.includes('PRIVATE KEY')) throw new Error('not a PEM private key');
    cachedKey = { path, pem };
    return pem;
  } catch (err) {
    console.error(
      `GITHUB_APP_PRIVATE_KEY_PATH can't be read (${err instanceof Error ? err.message.split('\n', 1)[0] : 'error'}); GitHub stays off`,
    );
    return null;
  }
}

function fromEnv(): Partial<GithubConfig> {
  // The key file is read only when the rest of GitHub is set up (in production it may be a
  // placeholder mount when GitHub isn't configured).
  const rest =
    env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET;
  return {
    appId: env.GITHUB_APP_ID,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_CLIENT_ID || undefined,
    clientSecret: env.GITHUB_CLIENT_SECRET || undefined,
    privateKey: rest ? (privateKeyFromEnv() ?? undefined) : undefined,
    apiUrl: env.GITHUB_API_URL,
    webUrl: env.GITHUB_WEB_URL,
    allowHttp: env.NODE_ENV === 'test' || env.GITHUB_ALLOW_HTTP,
  };
}

/** The complete configuration, or null when GitHub isn't set up on this DevSpace. */
export function githubConfig(): GithubConfig | null {
  const c = override ? { ...fromEnv(), ...override } : fromEnv();
  if (!c.appId || !c.slug || !c.clientId || !c.clientSecret || !c.privateKey) return null;
  return c as GithubConfig;
}

export const notConfigured = () =>
  new HttpError(409, 'github_not_configured', "GitHub isn't set up on this DevSpace yet");

/** The configuration, or 409 `github_not_configured`. */
export function requireGithubConfig(): GithubConfig {
  const c = githubConfig();
  if (!c) throw notConfigured();
  return c;
}

/** Where people install the app: GITHUB_WEB_URL/apps/<slug>/installations/new. */
export function installUrlOf(c: GithubConfig): string {
  return `${c.webUrl}/apps/${encodeURIComponent(c.slug)}/installations/new`;
}

/** The repository's Git address, built from our own web base (never from an API answer). */
export function gitUrlOf(c: GithubConfig, fullName: string): string {
  return `${c.webUrl}/${fullName}.git`;
}

/** The repository's page. */
export function htmlUrlOf(c: GithubConfig, fullName: string): string {
  return `${c.webUrl}/${fullName}`;
}

/** Tests: replace parts of the configuration (null goes back to the environment). */
export function useGithubConfig(next: Override): void {
  if (next !== null && env.NODE_ENV !== 'test') {
    throw new Error('useGithubConfig is for tests only');
  }
  override = next;
}
