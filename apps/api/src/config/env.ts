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

/** An http(s) origin such as `https://app.example.com` (no path, query or trailing slash). */
const origin = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
      } catch {
        return false;
      }
    }, 'must be an origin like https://example.com (no path or trailing slash)');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Redis, for queueing jobs for the worker (the worker reads the same variable). */
    REDIS_URL: z.string().trim().min(1).default('redis://localhost:6379'),
    /** Where the projects' bare Git repositories live. Relative paths resolve against the cwd. */
    REPOS_DIR: folder(DEFAULT_REPOS_DIR),
    /** Where the members' working copies live: `<COPIES_DIR>/<projectId>/<copyId>`. */
    COPIES_DIR: folder(DEFAULT_COPIES_DIR),
    /** Docker's local socket. Docker is never reached over TCP. */
    DOCKER_SOCKET: z
      .string()
      .trim()
      .default('/var/run/docker.sock')
      .refine((value) => isAbsolute(value), 'DOCKER_SOCKET must be an absolute socket path'),
    /** The IDE image (built by `npm run ide:build`). */
    IDE_IMAGE: z.string().trim().min(1).default('devspace-ide:2'),
    /** The Docker network IDE containers join (made by `npm run ide:network`). */
    IDE_NETWORK: z.string().trim().min(1).default('devspace-ide'),
    /** The second listener, which serves only the IDE (its own site: never the app's cookies). */
    IDE_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    /** The address the IDE listener binds (IPv4 loopback by default, reachable from Windows). */
    IDE_HOST: z.string().trim().min(1).default('127.0.0.1'),
    /** The web app's public origin: the only page allowed to frame the IDE or POST to /api. */
    APP_ORIGIN: origin('http://localhost:5173'),
    /**
     * The IDE listener's public origin. Must be a different site from APP_ORIGIN (in development
     * `127.0.0.1` vs `localhost`; in production its own registrable domain).
     */
    IDE_ORIGIN: origin('http://127.0.0.1:3100'),
  })
  .refine(
    (e) => {
      try {
        return new URL(e.APP_ORIGIN).hostname !== new URL(e.IDE_ORIGIN).hostname;
      } catch {
        return true; // already reported by the field checks
      }
    },
    {
      message: 'IDE_ORIGIN must be on a different host (site) from APP_ORIGIN',
      path: ['IDE_ORIGIN'],
    },
  );

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
