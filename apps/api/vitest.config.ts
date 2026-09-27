import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests hit the real database; load apps/api/.env when present.
    setupFiles: ['./test/setup.ts'],
  },
});
