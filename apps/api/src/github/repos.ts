import {
  GithubRepoListResponseSchema,
  type GithubRepo,
  type GithubRepoListResponse,
} from '@devspace/shared';
import { HttpError } from '../lib/http-error.ts';
import { claimImport, assertCanSetUp } from '../repository/service.ts';
import { startImport } from '../repository/import.ts';
import { installationToken, isRepo, listAll, type GhRepo } from './api.ts';
import { githubError, userInstallations, withUserToken } from './account.ts';
import {
  gitUrlOf,
  htmlUrlOf,
  installUrlOf,
  requireGithubConfig,
  type GithubConfig,
} from './config.ts';
import { authEnv, gitTransportOptions } from './push.ts';

/**
 * Repositories a member can reach through the DevSpace app (Phase 13), and importing one of them
 * (private included) at repository setup. The clone uses an installation token limited to that
 * repository with read access, through per-command config only.
 */

interface Reachable {
  repo: GhRepo;
  installationId: number;
}

async function reachableRepos(c: GithubConfig, userId: string): Promise<Reachable[]> {
  return withUserToken(c, userId, async (token) => {
    const out: Reachable[] = [];
    const seen = new Set<number>();
    for (const installation of await userInstallations(c, token)) {
      const repos = await listAll<GhRepo>(
        c,
        `/user/installations/${installation.id}/repositories`,
        token,
        (data) => {
          const list = (data as { repositories?: unknown } | null)?.repositories;
          return Array.isArray(list) ? list.filter(isRepo) : [];
        },
      );
      for (const repo of repos) {
        if (seen.has(repo.id)) continue;
        seen.add(repo.id);
        out.push({ repo, installationId: installation.id });
      }
    }
    return out;
  });
}

function toView(c: GithubConfig, repo: GhRepo): GithubRepo {
  return {
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
    htmlUrl: htmlUrlOf(c, repo.full_name),
    sizeKb: typeof repo.size === 'number' && repo.size >= 0 ? Math.floor(repo.size) : 0,
  };
}

/** GET /api/github/repos. */
export async function listGithubRepos(userId: string): Promise<GithubRepoListResponse> {
  const c = requireGithubConfig();
  let repos: Reachable[];
  try {
    repos = await reachableRepos(c, userId);
  } catch (err) {
    throw githubError(err, 'Could not list your GitHub repositories');
  }
  return GithubRepoListResponseSchema.parse({
    repos: repos
      .map((r) => toView(c, r.repo))
      .sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase())),
    installUrl: installUrlOf(c),
  });
}

/**
 * POST /repository { source: 'github', repoFullName } (the route checked `repository.setup`).
 * Finds the repository among those reachable through the app, then starts the background clone
 * with the Phase 4 limits (200 MB, 5 minutes). Not linked for syncing until published.
 */
export async function startGithubImport(
  projectId: string,
  userId: string,
  repoFullName: string,
): Promise<void> {
  const c = requireGithubConfig();
  await assertCanSetUp(projectId);
  let found: Reachable | undefined;
  try {
    const repos = await reachableRepos(c, userId);
    found = repos.find((r) => r.repo.full_name.toLowerCase() === repoFullName.toLowerCase());
  } catch (err) {
    throw githubError(err, 'Could not reach GitHub');
  }
  if (!found) {
    throw new HttpError(
      404,
      'github_repo_not_found',
      "DevSpace can't reach that repository; install the DevSpace app on it (or pick another)",
      undefined,
      { installUrl: installUrlOf(c) },
    );
  }
  let token: string;
  try {
    token = await installationToken(c, String(found.installationId), String(found.repo.id), 'read');
  } catch (err) {
    throw githubError(err, 'GitHub refused access to that repository');
  }
  const fullName = found.repo.full_name;
  const cloneUrl = gitUrlOf(c, fullName);
  const url = htmlUrlOf(c, fullName);
  await claimImport(projectId, url, 'github');
  startImport(
    projectId,
    {
      url,
      cloneUrl,
      env: authEnv(cloneUrl, token),
      ...gitTransportOptions(c, cloneUrl),
      kind: 'github',
    },
    userId,
  );
}
