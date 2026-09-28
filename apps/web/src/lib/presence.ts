import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PreferencesSchema,
  PresenceListResponseSchema,
  type Preferences,
  type PresenceState,
  type PresenceView,
} from '@devspace/shared';
import { apiFetch, apiPatch } from './api';
import { usePollInterval } from './liveStore';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

/** Without a live connection, presence is re-read this often (60 s with one). */
export const PRESENCE_REFRESH_MS = 30_000;

export const presenceKeys = {
  // Under the project's key, so refreshing a project refreshes its presence too.
  list: (projectId: string) => [...queryKeys.project(projectId), 'presence'] as const,
  preferences: ['me', 'preferences'] as const,
};

/** GET /api/projects/:projectId/presence: every member's state. Live events update it in place. */
export function usePresence(projectId: string) {
  const interval = usePollInterval(PRESENCE_REFRESH_MS);
  return useQuery({
    queryKey: presenceKeys.list(projectId),
    queryFn: async () =>
      PresenceListResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}/presence`))
        .members,
    refetchInterval: (query) => (query.state.status === 'error' ? false : interval),
  });
}

/** Put one member's new presence into the list (a `presence` event). */
export function replacePresence(
  list: PresenceView[] | undefined,
  member: PresenceView,
): PresenceView[] | undefined {
  if (!list) return list;
  return list.some((m) => m.user.id === member.user.id)
    ? list.map((m) => (m.user.id === member.user.id ? member : m))
    : [...list, member];
}

const STATE_ORDER: Record<PresenceState, number> = { active: 0, online: 1, offline: 2 };

/** Me first, then Active, Online, Offline, each by name. */
export function sortPresence(list: PresenceView[], myId: string): PresenceView[] {
  return [...list].sort(
    (a, b) =>
      Number(b.user.id === myId) - Number(a.user.id === myId) ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.user.name.localeCompare(b.user.name),
  );
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  active: 'Active',
  online: 'Online',
  offline: 'Offline',
};

/**
 * What the member is doing, as plain text: "editing src/app.ts", or "in Grace’s copy: src/app.ts"
 * for a lead helping in someone else's copy. Null when there is no file to show.
 */
export function presenceFileText(member: PresenceView): string | null {
  if (member.state !== 'active' || member.file === null) return null;
  if (member.copyOwner) return `in ${member.copyOwner.name}’s copy: ${member.file}`;
  return `editing ${member.file}`;
}

// ---------- My preferences ----------

export function usePreferences(enabled: boolean) {
  return useQuery({
    queryKey: presenceKeys.preferences,
    queryFn: async () => PreferencesSchema.parse(await apiFetch('/api/me/preferences')),
    enabled,
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Preferences) =>
      PreferencesSchema.parse(await apiPatch('/api/me/preferences', changes)),
    onSuccess: (preferences) => {
      queryClient.setQueryData(presenceKeys.preferences, preferences);
      // My own row on any open Team panel changes (file shown or not).
      return queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'projects' && query.queryKey[2] === 'presence',
      });
    },
  });
}
