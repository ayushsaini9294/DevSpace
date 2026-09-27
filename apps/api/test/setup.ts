import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';

// Each test file gets its own repositories and copies folders, deleted when the file finishes.
const reposDir = mkdtempSync(join(tmpdir(), 'devspace-repos-'));
const copiesDir = mkdtempSync(join(tmpdir(), 'devspace-copies-'));
process.env.REPOS_DIR = reposDir;
process.env.COPIES_DIR = copiesDir;
afterAll(() => {
  for (const dir of [reposDir, copiesDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
