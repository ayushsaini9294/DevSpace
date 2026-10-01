import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GithubAccountViewSchema,
  GithubConnectStartResponseSchema,
  GithubRepoListResponseSchema,
  ProjectGithubViewSchema,
  type GithubConnectFinishRequest,
  type ProjectGithubView,
  type PublishGithubRequest,
} from '@devspace/shared';
import { browser } from './ai';
import { ApiError, apiDelete, apiFetch, apiPost } from './api';
import { errorMessage } from './formErrors';
import { usePollInterval } from './liveStore';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

export const GITHUB_SETTINGS_URL = '/settings/github';

/** While a push to GitHub runs, re-read the project's GitHub status this often. */
export const GITHUB_PUSH_POLL_MS = 3000;

export const githubKeys = {
  account: ['github', 'account'] as const,
  repos: ['github', 'repos'] as const,
  // Under the project's key, so refreshing a project refreshes its GitHub status too.
  project: (projectId: string) => [...queryKeys.project(projectId), 'github'] as const,
};

function projectApi(projectId: string, rest = ''): string {
  return `/api/projects/${enc(projectId)}/github${rest}`;
}

// ---------- My GitHub account ----------

/** GET /api/github/account: whether GitHub is set up here, and whether I connected mine. */
export function useGithubAccount(enabled = true) {
  return useQuery({
    queryKey: githubKeys.account,
    queryFn: async () => GithubAccountViewSchema.parse(await apiFetch('/api/github/account')),
    enabled,
  });
}

/** POST /api/github/connect/start, then leave for GitHub's authorize page (same tab). */
export function useStartGithubConnect() {
  return useMutation({
    mutationFn: async () =>
      GithubConnectStartResponseSchema.parse(await apiPost('/api/github/connect/start')).url,
    onSuccess: (url) => {
      if (/^https?:\/\//i.test(url)) browser.leaveFor(url);
    },
  });
}

/** POST /api/github/connect/finish with the code GitHub sent back. */
export function useFinishGithubConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: GithubConnectFinishRequest) =>
      GithubAccountViewSchema.parse(await apiPost('/api/github/connect/finish', request)),
    onSuccess: (account) => {
      queryClient.setQueryData(githubKeys.account, account);
      return queryClient.invalidateQueries({ queryKey: githubKeys.repos });
    },
  });
}

/** DELETE /api/github/account: forget my GitHub tokens. */
export function useDisconnectGithub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiDelete('/api/github/account');
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: githubKeys.account }),
        queryClient.removeQueries({ queryKey: githubKeys.repos }),
      ]),
  });
}

/** GET /api/github/repos: the repositories I can import through the DevSpace app. */
export function useGithubRepos(enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.repos,
    queryFn: async () => GithubRepoListResponseSchema.parse(await apiFetch('/api/github/repos')),
    enabled,
  });
}

// ---------- A project on GitHub ----------

/** GET …/github: the project's GitHub link and what I may do. Polls while a push runs. */
export function useProjectGithub(projectId: string, enabled = true) {
  const interval = usePollInterval(GITHUB_PUSH_POLL_MS);
  return useQuery({
    queryKey: githubKeys.project(projectId),
    queryFn: async () => ProjectGithubViewSchema.parse(await apiFetch(projectApi(projectId))),
    enabled,
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.link?.status === 'pushing'
        ? interval
        : false,
  });
}

function useProjectGithubMutation<T>(projectId: string, send: (request: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = githubKeys.project(projectId);
  return useMutation({
    mutationFn: async (request: T) => ProjectGithubViewSchema.parse(await send(request)),
    onSuccess: (view: ProjectGithubView) => {
      queryClient.setQueryData(key, view);
      return queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) });
    },
    onError: (error) => {
      // Someone else changed it meanwhile (published, unlinked): show the real state.
      if (error instanceof ApiError && error.status === 409) {
        return queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** POST …/github/publish: create the repository on my GitHub and send main to it. */
export function usePublishGithub(projectId: string) {
  return useProjectGithubMutation(projectId, (request: PublishGithubRequest) =>
    apiPost(projectApi(projectId, '/publish'), request),
  );
}

/** POST …/github/sync: "Try again" after a pause or a failure. */
export function useSyncGithub(projectId: string) {
  return useProjectGithubMutation(projectId, () => apiPost(projectApi(projectId, '/sync')));
}

/** DELETE …/github: stop sending to GitHub (the repository stays on GitHub). */
export function useUnlinkGithub(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiDelete(projectApi(projectId));
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: githubKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
      ]),
  });
}

// ---------- Display ----------

export const NOT_CONFIGURED_MESSAGE = 'GitHub isn’t set up on this DevSpace yet.';

/** The install link the server sent with `app_not_installed`, if any. */
export function installUrlOf(error: unknown): string | null {
  const details = error instanceof ApiError ? error.errorResponse?.details : undefined;
  const url = details?.installUrl;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Clear words for the API's GitHub error codes; the server's message otherwise. */
export function githubErrorMessage(error: unknown): string {
  const body = error instanceof ApiError ? error.errorResponse : null;
  switch (body?.error) {
    case 'github_not_configured':
      return NOT_CONFIGURED_MESSAGE;
    case 'github_not_connected':
      return 'Connect your GitHub account first, on the GitHub settings page. If you connected it before, GitHub no longer accepts that connection: connect it again.';
    case 'app_not_installed':
      return 'The DevSpace app isn’t installed on your GitHub account yet. Install it, then try again.';
    case 'repo_exists':
      return 'You already have a repository with this name on GitHub. Pick another name.';
    case 'invalid_state':
      return 'This connection link has expired or was already used. Start again with Connect GitHub.';
    case 'email_warning_not_accepted':
      return 'Tick “I understand these addresses will be public on GitHub” to go ahead.';
    case 'already_published':
      return 'This project is already on GitHub.';
    case 'not_published':
      return 'This project isn’t on GitHub.';
    case 'sync_running':
      return 'DevSpace is already sending main to GitHub. Wait for it to finish.';
    case 'repository_not_ready':
      return 'The project’s repository isn’t set up yet, so there is nothing to send to GitHub.';
    case 'github_repo_not_found':
      return 'DevSpace can’t reach this GitHub repository. Check that the DevSpace app is installed for it, then pick it again.';
    case 'github_permission_denied':
      return `GitHub didn’t allow this: ${body.message}`;
    case 'github_error':
      return `GitHub didn’t accept the request: ${body.message}`;
    case 'forbidden':
      return 'You don’t have permission to do this.';
    default:
      return errorMessage(error);
  }
}
