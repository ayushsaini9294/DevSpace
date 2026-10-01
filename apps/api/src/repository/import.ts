import { MAX_IMPORT_BYTES } from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import { GitError, redact, runGit } from '../git/run.ts';
import { initBare, MAIN_REF, refExists } from '../git/repo.ts';
import { prisma } from '../lib/prisma.ts';
import {
  ensureReposDir,
  folderSize,
  importTempDir,
  moveIntoPlace,
  removeDir,
  repoDir,
} from './storage.ts';
import { transaction } from '../lib/transaction.ts';

export const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 1000;

export const INTERRUPTED_MESSAGE = 'The import was interrupted; please try again';

/** An import failure with a message written for the person who started it. */
class ImportFailure extends Error {}

const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

/** Resolves once every import running in this process has finished (for tests and shutdown). */
export async function waitForImports(): Promise<void> {
  await Promise.all([...running.values()].map((r) => r.done));
}

/** Stops a running import (e.g. its project is being deleted). */
export function cancelImport(projectId: string): Promise<void> {
  const entry = running.get(projectId);
  if (!entry) return Promise.resolve();
  entry.controller.abort();
  return entry.done;
}

/**
 * Where an import clones from. A public link (Phase 4) is cloned as is; a GitHub repository
 * (Phase 13) is cloned from `cloneUrl` with an installation token in `env` (per-command config,
 * never in argv or the URL). `url` is what the project records (and guards the update with).
 */
export interface ImportSource {
  url: string;
  cloneUrl?: string;
  env?: Record<string, string>;
  allowHttp?: boolean;
  /** `github`: a private repository is expected; failures say so. */
  kind?: 'public' | 'github';
}

/** Turns what git reported into a plain-language reason. */
function describeGitFailure(err: GitError, host: string, kind: ImportSource['kind']): string {
  const text = err.stderr.toLowerCase();
  if (
    kind === 'github' &&
    /terminal prompts disabled|could not read (username|password)|authentication failed|repository not found|not found|returned error: 40[134]|access denied|http 40[134]/.test(
      text,
    )
  ) {
    return "GitHub didn't let DevSpace read the repository; check that the DevSpace app has access to it";
  }
  if (
    /terminal prompts disabled|could not read (username|password)|authentication failed|repository not found|not found|returned error: 40[134]|access denied|http 40[134]/.test(
      text,
    )
  ) {
    return "The repository wasn't found or isn't public";
  }
  if (/redirect/.test(text)) {
    return 'The link redirects somewhere else; paste the repository’s current link';
  }
  if (
    /could not resolve host|failed to connect|couldn't connect|connection (timed out|refused|reset)|network is unreachable|ssl|tls/.test(
      text,
    )
  ) {
    return `Couldn't reach ${host}; please try again later`;
  }
  return 'The import failed; check the link and try again';
}

async function cloneMainBranch(
  source: ImportSource,
  dir: string,
  signal: AbortSignal,
  deadline: number,
) {
  const url = source.cloneUrl ?? source.url;
  const extra = { env: source.env, allowHttp: source.allowHttp };
  const remaining = () => Math.max(1, deadline - Date.now());
  await initBare(dir);

  // Which branch is the source's default? `ref: refs/heads/<name>\tHEAD`.
  const { stdout } = await runGit(['ls-remote', '--symref', '--', url, 'HEAD'], {
    gitDir: dir,
    signal,
    timeoutMs: remaining(),
    maxBuffer: 64 * 1024,
    ...extra,
  });
  const lines = stdout.toString('utf8').split('\n').filter(Boolean);
  if (lines.length === 0) {
    throw new ImportFailure(
      'The repository is empty; add a commit to it first, or start with an empty repository',
    );
  }
  const symref = /^ref: (refs\/heads\/[^\s\0]+)\tHEAD$/.exec(lines[0] ?? '');
  // Without a symref (very old servers) fetch whatever HEAD points at.
  const branch = symref ? symref[1]! : 'HEAD';

  await runGit(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--',
      url,
      `+${branch}:${MAIN_REF}`,
    ],
    { gitDir: dir, signal, timeoutMs: remaining(), ...extra },
  );
  if (!(await refExists(dir, MAIN_REF))) {
    throw new ImportFailure("The repository's default branch couldn't be copied");
  }
  // Only main is kept: drop any other ref git may have written.
  const refs = await runGit(['for-each-ref', '--format=%(refname)'], { gitDir: dir });
  for (const ref of refs.stdout.toString('utf8').split('\n').filter(Boolean)) {
    if (ref !== MAIN_REF) await runGit(['update-ref', '-d', '--', ref], { gitDir: dir });
  }
  // No remote is configured (we fetched by URL), so the source isn't remembered in the config.
  await runGit(['config', '--local', '--remove-section', 'remote.origin'], { gitDir: dir }).catch(
    () => undefined,
  );
}

async function runImport(
  projectId: string,
  source: ImportSource,
  actorId: string,
  controller: AbortController,
) {
  const url = source.url;
  const temp = importTempDir(projectId);
  const target = repoDir(projectId);
  const host = new URL(url).hostname;
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  let reason: 'too_large' | 'timeout' | 'cancelled' | null = null;
  const stop = (why: typeof reason) => {
    reason ??= why;
    controller.abort();
  };

  const overall = setTimeout(() => stop('timeout'), IMPORT_TIMEOUT_MS);
  let measuring = false;
  const watchdog = setInterval(() => {
    if (measuring) return;
    measuring = true;
    folderSize(temp)
      .then((size) => {
        if (size > MAX_IMPORT_BYTES) stop('too_large');
      })
      .finally(() => {
        measuring = false;
      });
  }, WATCHDOG_INTERVAL_MS);

  try {
    await ensureReposDir();
    await removeDir(temp);
    try {
      await cloneMainBranch(source, temp, controller.signal, deadline);
      if ((await folderSize(temp)) > MAX_IMPORT_BYTES) stop('too_large');
    } finally {
      clearTimeout(overall);
      clearInterval(watchdog);
    }
    if (reason) throw new ImportFailure('stopped');
    await moveIntoPlace(temp, target);

    const done = await transaction(async (tx) => {
      const { count } = await tx.project.updateMany({
        where: { id: projectId, repoStatus: 'importing', importUrl: url },
        data: { repoStatus: 'ready', repoPath: target, repoError: null },
      });
      if (count === 1) {
        await recordActivity(tx, {
          projectId,
          actorId,
          action: 'repository.imported',
          data: { url },
        });
      }
      return count === 1;
    });
    // The project was deleted (or reset) while importing: don't leave an orphan behind.
    if (!done) await removeDir(target);
  } catch (err) {
    let message: string;
    if (reason === 'too_large') message = 'The repository is larger than 200 MB';
    else if (reason === 'timeout') message = 'The import took longer than 5 minutes';
    else if (reason === 'cancelled' || controller.signal.aborted)
      message = 'The import was cancelled';
    else if (err instanceof ImportFailure) message = err.message;
    else if (err instanceof GitError) message = describeGitFailure(err, host, source.kind);
    else message = 'The import failed because of a server error; please try again';

    if (err instanceof GitError) {
      console.error(
        `Import for project ${projectId} failed (${err.kind}, exit ${err.exitCode}): ${redact(err.stderr.trim())}`,
      );
    } else if (!(err instanceof ImportFailure)) {
      console.error(`Import for project ${projectId} failed:`, err);
    }

    await removeDir(temp).catch((e: unknown) =>
      console.error(`Could not remove ${temp}:`, e instanceof Error ? e.message : e),
    );
    await transaction(async (tx) => {
      const { count } = await tx.project.updateMany({
        where: { id: projectId, repoStatus: 'importing', importUrl: url },
        data: { repoStatus: 'failed', repoError: message, repoPath: null },
      });
      if (count === 1) {
        await recordActivity(tx, {
          projectId,
          actorId,
          action: 'repository.import_failed',
          data: { url, error: message },
        });
      }
    }).catch((e: unknown) => {
      // The project may have been deleted meanwhile; nothing else to update.
      console.error(
        `Could not record the failed import for ${projectId}:`,
        e instanceof Error ? e.message : e,
      );
    });
  }
}

/**
 * Starts copying `url` into the project's repository in the background. The caller has already
 * moved the project to `importing` with this URL (a conditional update, so one at a time).
 */
export function startImport(
  projectId: string,
  source: string | ImportSource,
  actorId: string,
): void {
  const controller = new AbortController();
  const from = typeof source === 'string' ? { url: source } : source;
  const done = runImport(projectId, from, actorId, controller).finally(() => {
    running.delete(projectId);
  });
  running.set(projectId, { controller, done });
}

/**
 * On startup: imports that were running when the API stopped can't be resumed. Mark them
 * failed so they can be retried, and delete their half-copied folders. `projectIds` limits
 * this to some projects (tests).
 */
export async function recoverInterruptedImports(projectIds?: string[]): Promise<number> {
  const where = {
    repoStatus: 'importing' as const,
    ...(projectIds ? { id: { in: projectIds } } : {}),
  };
  const stuck = await prisma.project.findMany({ where, select: { id: true } });
  if (stuck.length === 0) return 0;
  const ids = stuck.map((p) => p.id).filter((id) => !running.has(id));
  const { count } = await prisma.project.updateMany({
    where: { ...where, id: { in: ids } },
    data: { repoStatus: 'failed', repoError: INTERRUPTED_MESSAGE, repoPath: null },
  });
  for (const id of ids) {
    await removeDir(importTempDir(id)).catch((e: unknown) =>
      console.error(
        `Could not remove the temporary import folder for ${id}:`,
        e instanceof Error ? e.message : e,
      ),
    );
  }
  return count;
}
