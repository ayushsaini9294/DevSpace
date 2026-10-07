import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RATE_LIMITED_MESSAGE, apiPost, retryServerErrors } from './api';
import { errorMessage } from './formErrors';

const RATE_LIMITED = {
  error: 'rate_limited',
  message: 'Too many tries. Please wait a minute and try again.',
};

describe('retryServerErrors', () => {
  it('retries network and server failures briefly', () => {
    expect(retryServerErrors(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retryServerErrors(1, new ApiError(503, null))).toBe(true);
    expect(retryServerErrors(2, new ApiError(503, null))).toBe(false);
  });

  it('never retries a 429 (too many tries) or another client error', () => {
    expect(retryServerErrors(0, new ApiError(429, RATE_LIMITED))).toBe(false);
    expect(retryServerErrors(0, new ApiError(429, null))).toBe(false);
    expect(retryServerErrors(0, new ApiError(404, null))).toBe(false);
  });
});

describe('rate_limited errors', () => {
  it('show the API’s own message', () => {
    expect(errorMessage(new ApiError(429, RATE_LIMITED))).toBe(RATE_LIMITED.message);
  });

  it('use the same plain words when a 429 has no usual body', () => {
    expect(errorMessage(new ApiError(429, null))).toBe(RATE_LIMITED_MESSAGE);
  });
});

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
