import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env itself; use Node's built-in loader when the file exists.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Optional so `prisma generate` works without a database (e.g. in CI);
  // migrate commands fail with a clear error if it is missing.
  datasource: { url: process.env.DATABASE_URL },
});
