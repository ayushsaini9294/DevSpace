import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** `<repo root>/.data/repos`, found from this file's location (src/config or dist/config), not the cwd. */
const DEFAULT_REPOS_DIR = fileURLToPath(new URL('../../../../.data/repos', import.meta.url));

/** `<repo root>/.data/copies`, found the same way. */
const DEFAULT_COPIES_DIR = fileURLToPath(new URL('../../../../.data/copies', import.meta.url));

/** An optional folder setting: relative paths resolve against the cwd; unset → `fallback`. */
const folder = (fallback: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? (isAbsolute(value) ? value : resolve(value)) : fallback));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Where the projects' bare Git repositories live. Relative paths resolve against the cwd. */
  REPOS_DIR: folder(DEFAULT_REPOS_DIR),
  /** Where the members' working copies live: `<COPIES_DIR>/<projectId>/<copyId>`. */
  COPIES_DIR: folder(DEFAULT_COPIES_DIR),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export const env = loadEnv();
