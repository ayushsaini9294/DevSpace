import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

/**
 * The stand-in OpenRouter (a test double, e2e/stubs/openrouter.ts) that the API and worker call in
 * the e2e tests instead of the real OpenRouter (Phase 10). e2e/ai.spec.ts reads the same variable.
 */
const OPENROUTER_STUB_PORT = process.env.OPENROUTER_STUB_PORT || '4010';
const OPENROUTER_BASE_URL = `http://127.0.0.1:${OPENROUTER_STUB_PORT}`;
/**
 * The key that encrypts members' OpenRouter keys (32 bytes, base64). CI sets its own; otherwise
 * each run makes a throwaway one. Only the stand-in's fake keys are stored during e2e runs.
 */
const AI_SECRETS_KEY = process.env.AI_SECRETS_KEY || randomBytes(32).toString('base64');

/**
 * The stand-in GitHub (a test double, e2e/stubs/github.ts) that the API and worker call in the e2e
 * tests instead of real GitHub (Phase 13): one server for the web side (OAuth, the app install
 * page, git over HTTP) and the REST API under /api/v3. e2e/github.spec.ts reads the same port.
 */
const GITHUB_STUB_PORT = process.env.GITHUB_STUB_PORT || '4020';
const GITHUB_WEB_URL = `http://127.0.0.1:${GITHUB_STUB_PORT}`;
/**
 * The stand-in GitHub App's private key: a throwaway RSA key made for each run, outside the repo
 * (CI makes its own the same way and passes E2E_GITHUB_APP_KEY_PATH). Never a real key: the
 * owner's GITHUB_APP_PRIVATE_KEY_PATH is never read here. Playwright's workers load this file too;
 * they inherit E2E_GITHUB_APP_KEY_PATH, so the key is made once, by the first process.
 */
function throwawayGithubKey() {
  if (process.env.E2E_GITHUB_APP_KEY_PATH) return process.env.E2E_GITHUB_APP_KEY_PATH;
  const folder = mkdtempSync(join(tmpdir(), 'devspace-e2e-github-'));
  const path = join(folder, 'stand-in-app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  process.on('exit', () => rmSync(folder, { recursive: true, force: true }));
  process.env.E2E_GITHUB_APP_KEY_PATH = path;
  return path;
}
process.env.E2E_GITHUB_CLIENT_SECRET ||= randomBytes(20).toString('hex');
const GITHUB_ENV = {
  GITHUB_APP_ID: '1001',
  GITHUB_APP_SLUG: 'devspace-stand-in',
  GITHUB_APP_PRIVATE_KEY_PATH: throwawayGithubKey(),
  GITHUB_CLIENT_ID: 'Iv1.standin',
  GITHUB_CLIENT_SECRET: process.env.E2E_GITHUB_CLIENT_SECRET,
  GITHUB_WEB_URL,
  GITHUB_API_URL: `${GITHUB_WEB_URL}/api/v3`,
  // The stand-in speaks plain http on 127.0.0.1; the API and worker allow that only with this flag.
  GITHUB_ALLOW_HTTP: '1',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The stand-in OpenRouter (test double; Node 24 runs the .ts file directly), on 127.0.0.1.
      command: 'node e2e/stubs/openrouter.ts',
      url: `${OPENROUTER_BASE_URL}/__stub/health`,
      env: { OPENROUTER_STUB_PORT },
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
    {
      // The stand-in GitHub (test double), on 127.0.0.1. It keeps its repositories in a temporary
      // folder that it removes when it stops.
      command: 'node e2e/stubs/github.ts',
      url: `${GITHUB_WEB_URL}/__stub/health`,
      env: { ...GITHUB_ENV, GITHUB_STUB_PORT },
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
    {
      // Starts the API (:3000, plus its IDE listener on 127.0.0.1:3100), the web app (:5173) and
      // the worker (needs Redis on :6379; it updates copies after a merge or undo, which
      // e2e/merge.spec.ts waits for).
      // The API binds the IDE listener before the main one, so once /api/health answers, the IDE
      // listener is up too (it has no health path of its own: it serves only the IDE).
      // AI (Phase 10): the API and the worker both call OpenRouter (here the stand-in) and both
      // need AI_SECRETS_KEY; `npm run dev` passes this environment to both, and it wins over
      // apps/api/.env (Node's --env-file never overrides the environment). A dev server that is
      // already running (reused outside CI) keeps its own settings, so run e2e/ai.spec.ts with
      // CI=1 or with the dev server stopped.
      // GitHub (Phase 13): the same holds for GITHUB_* (the stand-in's addresses and this run's
      // throwaway app key); the worker pushes to GitHub after a merge, so both get them.
      command: 'npm run dev',
      env: { OPENROUTER_BASE_URL, AI_SECRETS_KEY, ...GITHUB_ENV },
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Already started by the command above; this entry only waits for the web app.
      command: 'node -e "setInterval(() => {}, 1 << 30)"',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
