import { useQuery } from '@tanstack/react-query';
import { HealthResponseSchema, type HealthResponse } from '@devspace/shared';
import type { ApiStatusState } from '../components/ApiStatus';
import { ApiError, apiFetch } from './api';

/** GET /api/health. A 503 still carries a HealthResponse body, so read it too. */
async function fetchHealth(): Promise<HealthResponse> {
  try {
    return HealthResponseSchema.parse(await apiFetch('/api/health'));
  } catch (err) {
    if (err instanceof ApiError) {
      const parsed = HealthResponseSchema.safeParse(err.body);
      if (parsed.success) return parsed.data;
    }
    throw err;
  }
}

export function useApiStatus(): ApiStatusState {
  const query = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });
  if (query.isPending) return 'checking';
  if (query.isSuccess && query.data.status === 'ok') return 'ok';
  return 'error';
}
