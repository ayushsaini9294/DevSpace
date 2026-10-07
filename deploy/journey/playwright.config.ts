import { defineConfig, devices } from '@playwright/test';

/**
 * The full journey against a running production stack (not part of the e2e suite):
 *
 *   bash deploy/smoke.sh --keep                        # the stack, in LOCAL mode
 *   npx playwright test -c deploy/journey/playwright.config.ts
 *
 * DEVSPACE_URL picks another address (default http://app.localhost:8088, smoke.sh's).
 */
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
  },
  outputDir: '../../test-results/journey',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
