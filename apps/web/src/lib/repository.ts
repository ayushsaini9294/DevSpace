import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileResponseSchema,
  RepoPathSchema,
  RepositoryResponseSchema,
  TreeResponseSchema,
  type RepositoryStatus,
  type SetUpRepositoryRequest,
} from '@devspace/shared';
import { apiFetch, apiPost } from './api';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

/** How often the repository status is re-read while an import runs. */
export const IMPORT_POLL_MS = 2000;

// Everything lives under the project's key, so refreshing a project refreshes its files too.
export const repositoryKeys = {
  status: (projectId: string) => [...queryKeys.project(projectId), 'repository'] as const,
  tree: (projectId: string, path: string) =>
    [...queryKeys.project(projectId), 'repository', 'tree', path] as const,
  file: (projectId: string, path: string) =>
    [...queryKeys.project(projectId), 'repository', 'file', path] as const,
};

export function useRepository(projectId: string) {
  return useQuery({
    queryKey: repositoryKeys.status(projectId),
    queryFn: async () =>
      RepositoryResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}/repository`))
        .repository,
    // Poll only while an import is running.
    refetchInterval: (query) => (query.state.data?.status === 'importing' ? IMPORT_POLL_MS : false),
  });
}

export function useSetUpRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: SetUpRepositoryRequest) =>
      RepositoryResponseSchema.parse(
        await apiPost(`/api/projects/${enc(projectId)}/repository`, data),
      ).repository,
    onSuccess: (repository: RepositoryStatus) => {
      queryClient.setQueryData(repositoryKeys.status(projectId), repository);
      return queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) });
    },
  });
}

export function useTree(projectId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: repositoryKeys.tree(projectId, path),
    queryFn: async () =>
      TreeResponseSchema.parse(
        await apiFetch(`/api/projects/${enc(projectId)}/tree?path=${enc(path)}`),
      ),
    enabled,
  });
}

export function useFile(projectId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: repositoryKeys.file(projectId, path),
    queryFn: async () =>
      FileResponseSchema.parse(
        await apiFetch(`/api/projects/${enc(projectId)}/file?path=${enc(path)}`),
      ),
    enabled,
  });
}

// ---------- Paths in URLs ----------

/** A repository path as URL path segments: each segment encoded, slashes kept. */
export function encodeRepoPath(path: string): string {
  return path.split('/').map(enc).join('/');
}

/**
 * The repository path from the part of a URL after `/files/` or `/blob/` (still encoded),
 * or null when it can't be decoded or isn't a valid repository path. One trailing slash is
 * allowed, so `/files/src/` is the `src` folder.
 */
export function decodeRepoPath(encoded: string): string | null {
  const trimmed = encoded.endsWith('/') ? encoded.slice(0, -1) : encoded;
  let path: string;
  try {
    path = trimmed.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  return RepoPathSchema.safeParse(path).success ? path : null;
}

export function filesUrl(projectId: string, path: string): string {
  const base = `/projects/${projectId}/files`;
  return path === '' ? base : `${base}/${encodeRepoPath(path)}`;
}

export function blobUrl(projectId: string, path: string): string {
  return `/projects/${projectId}/blob/${encodeRepoPath(path)}`;
}

/** The last segment of a path ("" for the root). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// ---------- Display ----------

const UNITS = ['KB', 'MB', 'GB'] as const;

/** "512 bytes", "1.5 KB", "2 MB" (1 KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

/** The first line of a commit message. */
export function commitTitle(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}
