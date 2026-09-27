import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const envFile = fileURLToPath(new URL('../../api/.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';

// Copies made by these tests live in a temporary folder, deleted when the file finishes.
const copiesDir = mkdtempSync(join(tmpdir(), 'devspace-worker-copies-'));
process.env.COPIES_DIR = copiesDir;
afterAll(() => rmSync(copiesDir, { recursive: true, force: true }));
