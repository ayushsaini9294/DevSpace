import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CopyResponseSchema,
  CopyUpdatePreviewSchema,
  CopyUpdateResponseSchema,
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

/**
 * Whose copy: `null` = my own; otherwise the user id of the member whose copy a leader or
 * co-leader opens (Phase 7, `copy.helpFixConflict`).
 */
export type CopyOwner = string | null;

// Under the project's key, so refreshing a project refreshes the copy too.
export const copyKeys = {
  mine: (projectId: string) => [...queryKeys.project(projectId), 'copy'] as const,
  member: (projectId: string, userId: string) =>
    [...queryKeys.project(projectId), 'member-copy', userId] as const,
  of: (projectId: string, owner: CopyOwner) =>
    owner === null ? copyKeys.mine(projectId) : copyKeys.member(projectId, owner),
  updatePreview: (projectId: string) => [...copyKeys.mine(projectId), 'update-preview'] as const,
};

/** The API base for a copy: `/copy` for mine, `/members/:userId/copy` for a member's. */
function copyApi(projectId: string, owner: CopyOwner, rest = ''): string {
  const who = owner === null ? '' : `/members/${enc(owner)}`;
  return `/api/projects/${enc(projectId)}${who}/copy${rest}`;
}

/** The web page for a project's IDE (my copy). */
export function idePageUrl(projectId: string): string {
  return `/projects/${projectId}/ide`;
}

/** The web page where a leader or co-leader opens a member's copy in the IDE. */
export function memberIdePageUrl(projectId: string, userId: string): string {
  return `/projects/${projectId}/members/${userId}/ide`;
}

/**
 * Whether to offer "Open IDE": every project member (any role) has their own copy, but only
 * once the project's repository is ready. The API checks this again.
 */
export function canOpenIde(project: ProjectDetail, repository: RepositoryStatus): boolean {
  return project.allowedActions.includes('project.view') && repository.status === 'ready';
}

/** Whether to offer "Open copy" on other members' rows (leaders and co-leaders). */
export function canOpenMemberCopies(project: ProjectDetail): boolean {
  return project.allowedActions.includes('copy.helpFixConflict');
}

/**
 * POST …/copy/ide/launch: a one-time launch URL for a running IDE, on the IDE's own site.
 * The shared schema accepts only an absolute http(s) URL, so anything else (a relative path,
 * `javascript:`) fails here and is never framed. Tickets are single-use and short-lived, so
 * this is a mutation, never cached: every open, retry or reload asks again.
 */
export function useLaunchIde(projectId: string, owner: CopyOwner = null) {
  return useMutation({
    mutationFn: async (): Promise<string> =>
      IdeLaunchResponseSchema.parse(await apiPost(copyApi(projectId, owner, '/ide/launch'))).url,
    gcTime: 0,
  });
}

/**
 * POST …/copy/preview/launch `{ port }`: a one-time URL that opens the app running on that port
 * of the copy's container, on the IDE's own site (Phase 11). Single-use like the IDE launch.
 */
export function useLaunchPreview(projectId: string, owner: CopyOwner = null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (port: number): Promise<string> =>
      IdeLaunchResponseSchema.parse(
        await apiPost(copyApi(projectId, owner, '/preview/launch'), { port }),
      ).url,
    gcTime: 0,
    // The "Preview your app" step may now be done.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.project(projectId), 'getting-started'],
      }),
  });
}

/**
 * The preview URL if it's safe to open: an absolute http(s) URL on this copy's IDE address (the
 * origin the copy's IDE itself was launched from), never the app's own origin. Null otherwise.
 */
export function safePreviewUrl(url: string, ideOrigin: string | null): string | null {
  if (ideOrigin === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin !== ideOrigin || parsed.origin === window.location.origin) return null;
  return parsed.href;
}

/**
 * The IDE launch URL if it's safe to frame: an absolute http(s) URL on this copy's own IDE
 * address, `http(s)://<copyId>.<IDE base host>[:port]` (each copy has its own), never the app's
 * own origin. Null otherwise.
 */
export function safeLaunchUrl(url: string, copyId: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin === window.location.origin) return null;
  const [firstLabel, ...rest] = parsed.hostname.split('.');
  if (rest.length === 0 || firstLabel !== copyId.toLowerCase()) return null;
  return parsed.href;
}

/** The origin of an absolute http(s) URL, or null. */
export function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * POST …/copy/ide: start (or reuse) the copy's IDE container. For my own copy it also makes
 * the copy if needed; a member's copy must already exist (404 otherwise).
 */
export function useStartIde(projectId: string, owner: CopyOwner = null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CopyView> =>
      // Always a copy here (never null).
      StartedCopyResponseSchema.parse(await apiPost(copyApi(projectId, owner, '/ide'))).copy,
    onSuccess: (copy) => queryClient.setQueryData(copyKeys.of(projectId, owner), copy),
  });
}

/**
 * GET …/copy: the copy (null if there is none). Polled about once a second while its container
 * is starting, and every `refreshMs` otherwise when given (so `behind` and unresolved conflict
 * files stay current); stops when a poll fails.
 */
export function useCopy(
  projectId: string,
  owner: CopyOwner,
  enabled: boolean,
  refreshMs: number | false = false,
) {
  return useQuery({
    queryKey: copyKeys.of(projectId, owner),
    queryFn: async () => CopyResponseSchema.parse(await apiFetch(copyApi(projectId, owner))).copy,
    enabled,
    // The start request has just stored a fresh answer; don't ask again straight away.
    staleTime: IDE_POLL_MS,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      return query.state.data?.containerStatus === 'starting' ? IDE_POLL_MS : refreshMs;
    },
  });
}

/** GET …/copy for my own copy. */
export function useMyCopy(projectId: string, enabled: boolean, refreshMs: number | false = false) {
  return useCopy(projectId, null, enabled, refreshMs);
}

/** GET …/copy/update: whether my copy is behind main and which files an update would conflict. */
export function useCopyUpdatePreview(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: copyKeys.updatePreview(projectId),
    queryFn: async () =>
      CopyUpdatePreviewSchema.parse(await apiFetch(copyApi(projectId, null, '/update'))),
    enabled,
    // Computed live from the files on disk, which the member may be changing right now.
    staleTime: 0,
    gcTime: 0,
  });
}

/** POST …/copy/update: bring main's changes into my copy (conflicts get markers). */
export function useUpdateMyCopy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      CopyUpdateResponseSchema.parse(await apiPost(copyApi(projectId, null, '/update'))),
    onSuccess: ({ copy }) => {
      queryClient.setQueryData(copyKeys.mine(projectId), copy);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: copyKeys.updatePreview(projectId) }),
        // My changed files are measured against the copy's base, which just moved.
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.project(projectId), 'copy', 'changes'],
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
      ]);
    },
  });
}

/** POST …/copy/packages-dismiss: hide the "Packages changed in main" reminder on my copy. */
export function useDismissPackagesReminder(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CopyView> =>
      StartedCopyResponseSchema.parse(await apiPost(copyApi(projectId, null, '/packages-dismiss')))
        .copy,
    onSuccess: (copy) => queryClient.setQueryData(copyKeys.mine(projectId), copy),
  });
}
