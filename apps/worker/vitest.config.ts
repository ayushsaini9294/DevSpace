import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The worker uses the API's database and Docker code: load apps/api/.env when present.
    setupFiles: ['./test/setup.ts'],
  },
});
