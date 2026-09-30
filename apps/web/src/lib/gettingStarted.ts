import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GettingStartedViewSchema, type InvalidateKey } from '@devspace/shared';
import { apiFetch, apiPost } from './api';
import { usePollInterval } from './liveStore';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

/**
 * Re-read the checklist this often. The server scans my copy for it, so it's kept slow: live
 * events, returning to the tab and my own actions refresh it in between.
 */
export const GETTING_STARTED_REFRESH_MS = 60_000;

export const gettingStartedKeys = {
  // Under the project's key, so refreshing a project refreshes the checklist too.
  view: (projectId: string) => [...queryKeys.project(projectId), 'getting-started'] as const,
};

/** GET …/getting-started: my checklist for this project, computed by the server. */
export function useGettingStarted(projectId: string) {
  const refresh = usePollInterval(GETTING_STARTED_REFRESH_MS);
  return useQuery({
    queryKey: gettingStartedKeys.view(projectId),
    queryFn: async () =>
      GettingStartedViewSchema.parse(
        await apiFetch(`/api/projects/${enc(projectId)}/getting-started`),
      ),
    refetchInterval: (query) => (query.state.status === 'error' ? false : refresh),
  });
}

/** POST …/getting-started/hide or …/show. */
export function useSetGettingStartedHidden(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (hidden: boolean) =>
      GettingStartedViewSchema.parse(
        await apiPost(
          `/api/projects/${enc(projectId)}/getting-started/${hidden ? 'hide' : 'show'}`,
        ),
      ),
    onSuccess: (view) => queryClient.setQueryData(gettingStartedKeys.view(projectId), view),
  });
}

/**
 * Whether a live `invalidate` key may have ticked one of my steps: the repository, members or
 * invitations, my copy, or submissions (and their reviews and comments).
 */
export function touchesGettingStarted(key: InvalidateKey, myId: string): boolean {
  if (key.startsWith('submission:')) return true;
  if (key.startsWith('copy:')) return key === `copy:${myId}`;
  return key === 'submissions' || key === 'repository' || key === 'members' || key === 'copy';
}
