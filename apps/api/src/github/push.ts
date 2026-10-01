import { GitError, redact, runGit } from '../git/run.ts';
import { GithubApiError, installationToken } from './api.ts';
import { gitUrlOf, type GithubConfig } from './config.ts';

/**
 * Talking Git to GitHub (Phase 13). The installation token goes only into the per-command
 * environment (`GIT_CONFIG_COUNT`/`KEY`/`VALUE` → `http.<url>.extraHeader`): never in argv, the
 * URL, a remote, a config file or a log. Pushes send only `<sha>:refs/heads/main` and never
 * force (no `+`, no `--force`).
 */

export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

/** Env that adds `Authorization: Basic x-access-token:<token>` for requests to `url` only. */
export function authEnv(url: string, token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** http:// is only for a stand-in GitHub, and only when the configuration allows it. */
export function gitTransportOptions(c: GithubConfig, url: string): { allowHttp: boolean } {
  const isHttp = url.startsWith('http://');
  if (isHttp && !c.allowHttp) throw new Error('GitHub over plain http is not allowed');
  return { allowHttp: isHttp };
}

export type PushOutcome =
  { kind: 'ok' } | { kind: 'non_fast_forward' } | { kind: 'failed'; reason: string };

/** Plain-language reason for a failed push or clone. */
export function describeGithubGitFailure(err: GitError): string {
  const text = err.stderr.toLowerCase();
  if (err.kind === 'timeout') return 'GitHub took too long to answer; DevSpace will try again';
  if (
    /authentication failed|could not read username|returned error: 40[13]|http 40[13]|permission|denied/.test(
      text,
    )
  ) {
    return 'GitHub refused access; check that the DevSpace app still has access to this repository';
  }
  if (/not found|returned error: 404|http 404/.test(text)) {
    return 'The repository was not found on GitHub (was it deleted or renamed?)';
  }
  if (
    /could not resolve host|failed to connect|couldn't connect|connection (timed out|refused|reset)|network is unreachable|ssl|tls/.test(
      text,
    )
  ) {
    return "Couldn't reach GitHub; DevSpace will try again";
  }
  return 'Pushing to GitHub failed; DevSpace will try again';
}

/**
 * Pushes `sha` (and its full history) to `refs/heads/main` of `fullName`, without force. A
 * rejection because GitHub has commits DevSpace doesn't is `non_fast_forward`.
 */
export async function pushMain(
  c: GithubConfig,
  gitDir: string,
  link: { installationId: bigint; repoId: bigint; repoFullName: string },
  sha: string,
): Promise<PushOutcome> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error('bad commit id');
  let token: string;
  try {
    token = await installationToken(c, String(link.installationId), String(link.repoId), 'write');
  } catch (err) {
    if (
      err instanceof GithubApiError &&
      err.kind === 'http' &&
      (err.status === 404 || err.status === 403 || err.status === 422)
    ) {
      return {
        kind: 'failed',
        reason:
          "The DevSpace app can't reach this repository any more (was it uninstalled, or the repository removed from it?)",
      };
    }
    return { kind: 'failed', reason: "Couldn't get access from GitHub; DevSpace will try again" };
  }
  const url = gitUrlOf(c, link.repoFullName);
  let stdout: string;
  let exitCode: number;
  try {
    const result = await runGit(
      ['push', '--porcelain', '--no-progress', '--no-verify', url, `${sha}:refs/heads/main`],
      {
        gitDir,
        env: authEnv(url, token),
        ...gitTransportOptions(c, url),
        timeoutMs: PUSH_TIMEOUT_MS,
        okExitCodes: [1],
      },
    );
    stdout = result.stdout.toString('utf8');
    exitCode = result.exitCode;
    if (exitCode !== 0 || /^!\t/m.test(stdout)) {
      const line = stdout.split('\n').find((l) => l.startsWith('!\t')) ?? '';
      if (/\[rejected\]/.test(line) && /(fetch first|non-fast-forward)/.test(line)) {
        return { kind: 'non_fast_forward' };
      }
      console.error(
        `Push to GitHub ${link.repoFullName} was rejected: ${redact(line || result.stderr.trim()).slice(0, 500)}`,
      );
      const remote = /\[remote rejected\]\s*\(([^)]*)\)/.exec(line)?.[1];
      return {
        kind: 'failed',
        reason: remote
          ? `GitHub refused the push (${remote.slice(0, 200)})`
          : 'GitHub refused the push; DevSpace will try again',
      };
    }
    return { kind: 'ok' };
  } catch (err) {
    if (err instanceof GitError) {
      console.error(
        `Push to GitHub ${link.repoFullName} failed (${err.kind}, exit ${err.exitCode}): ${redact(err.stderr.trim()).slice(0, 1000)}`,
      );
      return { kind: 'failed', reason: describeGithubGitFailure(err) };
    }
    throw err;
  }
}
