import { randomBytes } from 'node:crypto';
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
      command: 'npm run dev',
      env: { OPENROUTER_BASE_URL, AI_SECRETS_KEY },
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
