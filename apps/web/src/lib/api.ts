import { ErrorResponseSchema, type ErrorResponse } from '@devspace/shared';

/** Error thrown by apiFetch when the server answers with a non-2xx status. */
export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON body of the error response, or null if it had none. */
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** The body as the shared ErrorResponse shape, or null if it doesn't match. */
  get errorResponse(): ErrorResponse | null {
    const parsed = ErrorResponseSchema.safeParse(this.body);
    return parsed.success ? parsed.data : null;
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Fetch a JSON endpoint of the DevSpace API, sending the session cookie.
 * Resolves with the parsed body on 2xx (null for 204 No Content); throws ApiError otherwise.
 * Callers validate the result with a Zod schema from @devspace/shared.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const body = await readJson(res);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

/** POST a JSON body. The API rejects non-JSON POSTs with 415, so there is always one. */
export function apiPost(path: string, data: unknown = {}): Promise<unknown> {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(data) });
}

/** PATCH a JSON body. */
export function apiPatch(path: string, data: unknown): Promise<unknown> {
  return apiFetch(path, { method: 'PATCH', body: JSON.stringify(data) });
}

/** DELETE, always with a JSON body (`{}` when there is nothing to send) so it passes the JSON-only check. */
export function apiDelete(path: string, data: unknown = {}): Promise<unknown> {
  return apiFetch(path, { method: 'DELETE', body: JSON.stringify(data) });
}

/** Retry only network and server failures, briefly; client errors (4xx) won't fix themselves. */
export function retryServerErrors(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && !(error instanceof ApiError && error.status < 500);
}
