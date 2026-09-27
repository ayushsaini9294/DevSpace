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
}

async function readJson(res: Response): Promise<unknown> {
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
 * Resolves with the parsed body on 2xx; throws ApiError otherwise.
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
