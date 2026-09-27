import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CopyResponseSchema,
  CopyViewSchema,
  IdeLaunchResponseSchema,
  type CopyView,
  type ProjectDetail,
  type RepositoryStatus,
} from '@devspace/shared';
import { apiFetch, apiPost } from './api';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

const StartedCopyResponseSchema = CopyResponseSchema.extend({ copy: CopyViewSchema });

/** How often the copy is re-read while its IDE container starts. */
export const IDE_POLL_MS = 1000;

// Under the project's key, so refreshing a project refreshes the copy too.
export const copyKeys = {
  mine: (projectId: string) => [...queryKeys.project(projectId), 'copy'] as const,
};

/** The web page for a project's IDE. */
export function idePageUrl(projectId: string): string {
  return `/projects/${projectId}/ide`;
}

/**
 * Whether to offer "Open IDE": every project member (any role) has their own copy, but only
 * once the project's repository is ready. The API checks this again.
 */
export function canOpenIde(project: ProjectDetail, repository: RepositoryStatus): boolean {
  return project.allowedActions.includes('project.view') && repository.status === 'ready';
}

/**
 * POST …/copy/ide/launch: a one-time launch URL for my running IDE, on the IDE's own site.
 * The shared schema accepts only an absolute http(s) URL, so anything else (a relative path,
 * `javascript:`) fails here and is never framed. Tickets are single-use and short-lived, so
 * this is a mutation, never cached: every open, retry or reload asks again.
 */
export function useLaunchIde(projectId: string) {
  return useMutation({
    mutationFn: async (): Promise<string> =>
      IdeLaunchResponseSchema.parse(
        await apiPost(`/api/projects/${enc(projectId)}/copy/ide/launch`),
      ).url,
    gcTime: 0,
  });
}

/** POST …/copy/ide: make my copy if needed and start (or reuse) its IDE container. */
export function useStartIde(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CopyView> =>
      // Always a copy here (never null): the endpoint makes one if needed.
      StartedCopyResponseSchema.parse(await apiPost(`/api/projects/${enc(projectId)}/copy/ide`))
        .copy,
    onSuccess: (copy) => queryClient.setQueryData(copyKeys.mine(projectId), copy),
  });
}

/**
 * GET …/copy: my copy (null if I have none). Polled about once a second while its container
 * is starting; stops once it is running, failed or stopped, or when a poll fails.
 */
export function useMyCopy(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: copyKeys.mine(projectId),
    queryFn: async () =>
      CopyResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}/copy`)).copy,
    enabled,
    // The start request has just stored a fresh answer; don't ask again straight away.
    staleTime: IDE_POLL_MS,
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.containerStatus === 'starting'
        ? IDE_POLL_MS
        : false,
  });
}
