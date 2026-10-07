import { defineConfig, devices } from '@playwright/test';

/**
 * The full journey against a running production stack (not part of the e2e suite):
 *
 *   bash deploy/smoke.sh --keep                        # the stack, in LOCAL mode
 *   npx playwright test -c deploy/journey/playwright.config.ts
 *
 * DEVSPACE_URL picks another address (default http://app.localhost:8088, smoke.sh's).
 * DEVSPACE_RESOLVE (e.g. '*.test') sends those names to 127.0.0.1 and accepts a self-signed
 * certificate: the tunnel-mode proof (bash deploy/tunnel-smoke.sh --keep, then
 * DEVSPACE_URL=https://devspace-app.test DEVSPACE_RESOLVE='*.test').
 */
const resolve = process.env.DEVSPACE_RESOLVE;

export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.DEVSPACE_URL || 'http://app.localhost:8088',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(resolve
      ? {
          ignoreHTTPSErrors: true,
          launchOptions: { args: [`--host-resolver-rules=MAP ${resolve} 127.0.0.1`] },
        }
      : {}),
  },
  outputDir: '../../test-results/journey',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
