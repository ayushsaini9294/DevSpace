import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiPost } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('resolves with null for 204 No Content and sends JSON with credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiPost('/api/auth/logout')).resolves.toBeNull();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('throws ApiError with the parsed ErrorResponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unauthenticated', message: 'Log in first' }), {
            status: 401,
          }),
      ),
    );
    const error = await apiPost('/api/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).errorResponse?.error).toBe('unauthenticated');
  });
});
