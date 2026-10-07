import { describe, expect, it } from 'vitest';
import { ideHostUnderApp, parseEnv } from '../src/config/env.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

/** A complete, valid production environment (none of these are real secrets). */
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://devspace:a-strong-password@127.0.0.1:5432/devspace',
  AI_SECRETS_KEY: KEY,
  APP_ORIGIN: 'https://devspace.example',
  IDE_BASE_URL: 'https://devspace-ide.example',
};

function issues(source: Record<string, string | undefined>): string[] {
  const result = parseEnv(source);
  return result.ok ? [] : result.issues;
}

describe('environment checks (Phase 14)', () => {
  it('accepts a complete production setup and the development defaults', () => {
    expect(issues(production)).toEqual([]);
    const dev = parseEnv({ DATABASE_URL: 'postgresql://devspace:devspace@localhost:5432/x' });
    expect(dev.ok).toBe(false); // no AI_SECRETS_KEY outside tests
    const devOk = parseEnv({
      DATABASE_URL: 'postgresql://devspace:devspace@localhost:5432/x',
      AI_SECRETS_KEY: KEY,
    });
    expect(devOk.ok && devOk.env.IDE_BASE_URL).toBe('http://ide.localhost:3100');
    expect(devOk.ok && devOk.env.APP_ORIGIN).toBe('http://localhost:5173');
    expect(devOk.ok && devOk.env.TRUST_PROXY).toBe(false);
  });

  it('refuses to start while the old IDE_ORIGIN is set, saying to rename it', () => {
    const found = issues({ ...production, IDE_ORIGIN: 'https://ide.example' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^IDE_ORIGIN: was renamed.*IDE_BASE_URL/);
  });

  it('production refuses http addresses, one message each', () => {
    expect(issues({ ...production, APP_ORIGIN: 'http://devspace.example' })).toEqual([
      'APP_ORIGIN: must be https:// in production',
    ]);
    expect(issues({ ...production, IDE_BASE_URL: 'http://devspace-ide.example' })).toEqual([
      'IDE_BASE_URL: must be https:// in production',
    ]);
    expect(
      issues({
        ...production,
        APP_ORIGIN: 'http://devspace.example',
        IDE_BASE_URL: 'http://devspace-ide.example',
      }),
    ).toHaveLength(2);
  });

  it('production refuses a missing AI key and the development database password', () => {
    expect(issues({ ...production, AI_SECRETS_KEY: undefined })).toEqual([
      'AI_SECRETS_KEY: is required (32 bytes, base64: openssl rand -base64 32)',
    ]);
    expect(
      issues({ ...production, DATABASE_URL: 'postgresql://devspace:devspace@db:5432/devspace' }),
    ).toEqual([
      'DATABASE_URL: uses the development password "devspace": set a strong database password',
    ]);
  });

  it("refuses an IDE base host that is the app's host or under it (any NODE_ENV)", () => {
    for (const ide of ['https://devspace.example', 'https://ide.devspace.example']) {
      expect(issues({ ...production, IDE_BASE_URL: ide })).toEqual([
        "IDE_BASE_URL: IDE_BASE_URL's host must not be APP_ORIGIN's host or under it (use a separate domain)",
      ]);
      expect(issues({ ...production, NODE_ENV: 'test', IDE_BASE_URL: ide })).toHaveLength(1);
    }
    // A look-alike that only ends with the same letters is a different site.
    expect(issues({ ...production, IDE_BASE_URL: 'https://notdevspace.example' })).toEqual([]);
    expect(ideHostUnderApp('localhost', 'ide.localhost')).toBe(false);
    expect(ideHostUnderApp('localhost', 'localhost')).toBe(true);
    expect(ideHostUnderApp('app.localhost', 'x.app.localhost')).toBe(true);
    expect(ideHostUnderApp('app.localhost', 'ide.localhost')).toBe(false);
  });

  it('ALLOW_HTTP_LOCALHOST allows http only when both hosts are localhost or *.localhost', () => {
    const local = {
      ...production,
      APP_ORIGIN: 'http://app.localhost',
      IDE_BASE_URL: 'http://ide.localhost',
    };
    expect(issues(local)).toEqual([
      'APP_ORIGIN: must be https:// in production',
      'IDE_BASE_URL: must be https:// in production',
    ]);
    expect(issues({ ...local, ALLOW_HTTP_LOCALHOST: '1' })).toEqual([]);
    expect(
      issues({ ...local, ALLOW_HTTP_LOCALHOST: '1', APP_ORIGIN: 'http://localhost:8080' }),
    ).toEqual([]);
    // Either host anywhere else: both must be https.
    expect(
      issues({ ...local, ALLOW_HTTP_LOCALHOST: '1', IDE_BASE_URL: 'http://devspace-ide.example' }),
    ).toEqual([
      'APP_ORIGIN: must be https:// in production',
      'IDE_BASE_URL: must be https:// in production',
    ]);
    expect(
      issues({ ...local, ALLOW_HTTP_LOCALHOST: '1', APP_ORIGIN: 'http://devspace.example' }),
    ).toEqual([
      'APP_ORIGIN: must be https:// in production',
      'IDE_BASE_URL: must be https:// in production',
    ]);
    expect(
      issues({
        ...local,
        ALLOW_HTTP_LOCALHOST: '1',
        APP_ORIGIN: 'http://localhost.example',
      }),
    ).toHaveLength(2);
  });

  it('rate limits can be turned off only outside production', () => {
    expect(issues({ ...production, RATE_LIMITS: 'off' })).toEqual([
      'RATE_LIMITS: cannot be off in production',
    ]);
    expect(issues({ ...production, RATE_LIMITS: 'on' })).toEqual([]);
    expect(issues({ ...production, NODE_ENV: 'development', RATE_LIMITS: 'off' })).toEqual([]);
    expect(issues({ ...production, RATE_LIMITS: 'maybe' })).toHaveLength(1);
  });

  it('treats blank settings (compose `${VAR:-}`) as not set', () => {
    const blank = Object.fromEntries(
      [
        'AI_DEFAULT_MODELS',
        'AI_FALLBACK_MODELS',
        'OPENROUTER_BASE_URL',
        'TRUST_PROXY',
        'RATE_LIMITS',
        'ALLOW_HTTP_LOCALHOST',
        'GITHUB_APP_ID',
        'GITHUB_APP_SLUG',
        'GITHUB_APP_PRIVATE_KEY_PATH',
        'GITHUB_CLIENT_ID',
        'GITHUB_CLIENT_SECRET',
        'GITHUB_API_URL',
        'GITHUB_WEB_URL',
        'API_HOST',
        'IDE_ORIGIN',
        'REDIS_URL',
      ].map((name) => [name, '']),
    );
    const result = parseEnv({ ...production, ...blank });
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.env.AI_DEFAULT_MODELS.length).toBeGreaterThan(0);
    expect(result.env.GITHUB_APP_ID).toBeUndefined();
    expect(result.env.GITHUB_API_URL).toBe('https://api.github.com');
    expect(result.env.TRUST_PROXY).toBe(false);
    expect(result.env.RATE_LIMITS).toBeUndefined();
    expect(result.env.API_HOST).toBeUndefined();
    expect(result.env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('reads TRUST_PROXY like Express does, and refuses nonsense', () => {
    const trust = (value: string) => {
      const r = parseEnv({ ...production, TRUST_PROXY: value });
      return r.ok ? r.env.TRUST_PROXY : r.issues;
    };
    expect(trust('')).toBe(false);
    expect(trust('off')).toBe(false);
    expect(trust('true')).toBe(true);
    expect(trust('1')).toBe(1);
    expect(trust('loopback')).toBe('loopback');
    expect(trust('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(trust('not an address')).toEqual([
      'TRUST_PROXY: must be off, true, a hop count, loopback, or a list of addresses/CIDRs',
    ]);
  });
});
