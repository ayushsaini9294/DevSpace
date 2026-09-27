import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';

// Each test file gets its own repositories folder, deleted when the file finishes.
const reposDir = mkdtempSync(join(tmpdir(), 'devspace-repos-'));
process.env.REPOS_DIR = reposDir;
afterAll(() => {
  rmSync(reposDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
