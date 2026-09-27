import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AuthResponseSchema,
  type LogInRequest,
  type SignUpRequest,
  type User,
} from '@devspace/shared';
import { ApiError, apiFetch, apiPost } from './api';

export const currentUserQueryKey = ['auth', 'me'] as const;

/** GET /api/auth/me. A 401 means "logged out", which is a normal answer, not an error. */
async function fetchCurrentUser(): Promise<User | null> {
  try {
    return AuthResponseSchema.parse(await apiFetch('/api/auth/me')).user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** The logged-in user (null when logged out). The session lives in an HttpOnly cookie. */
export function useCurrentUser() {
  return useQuery({
    queryKey: currentUserQueryKey,
    queryFn: fetchCurrentUser,
    // Client errors (4xx) won't fix themselves; retry only network/server failures, briefly.
    retry: (failureCount, error) =>
      failureCount < 2 && !(error instanceof ApiError && error.status < 500),
  });
}

async function setCurrentUser(queryClient: QueryClient, user: User | null) {
  // A /me request that started before this change must not overwrite it with stale data.
  await queryClient.cancelQueries({ queryKey: currentUserQueryKey });
  queryClient.setQueryData<User | null>(currentUserQueryKey, user);
}

export function useSignUp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: SignUpRequest) =>
      AuthResponseSchema.parse(await apiPost('/api/auth/signup', data)).user,
    onSuccess: (user) => setCurrentUser(queryClient, user),
  });
}

export function useLogIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: LogInRequest) =>
      AuthResponseSchema.parse(await apiPost('/api/auth/login', data)).user,
    onSuccess: (user) => setCurrentUser(queryClient, user),
  });
}

export function useLogOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiPost('/api/auth/logout', {});
    },
    onSuccess: async () => {
      // Drop everything cached for the previous user, then mark the session as logged out.
      await queryClient.cancelQueries();
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] !== currentUserQueryKey[0] ||
          query.queryKey[1] !== currentUserQueryKey[1],
      });
      await setCurrentUser(queryClient, null);
    },
    // If logout failed we don't know the session state; ask the server again.
    onError: () => queryClient.invalidateQueries({ queryKey: currentUserQueryKey }),
  });
}
