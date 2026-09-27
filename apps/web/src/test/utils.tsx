import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import type { AuthResponse, ErrorResponse, HealthResponse, User } from '@devspace/shared';
import { routes as appRoutes } from '../app/routes';

export const testUser: User = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: '2026-09-27T10:00:00.000Z',
};

/** A canned API answer. Bodies are typed with the shared contract. */
export type StubReply =
  | { status: 200 | 201; body: AuthResponse | HealthResponse }
  | { status: 204 }
  | { status: 400 | 401 | 409 | 500 | 503; body: ErrorResponse | HealthResponse }
  | 'pending';

export type StubRoutes = Record<string, StubReply | (() => StubReply)>;

export const loggedIn: StubReply = { status: 200, body: { user: testUser } };
export const loggedOut: StubReply = {
  status: 401,
  body: { error: 'unauthenticated', message: 'Log in first' },
};
export const healthOk: StubReply = { status: 200, body: { status: 'ok', database: 'ok' } };

/**
 * Replace fetch with a tiny router keyed by "METHOD /path". Unknown requests fail the test.
 * Returns the mock so tests can inspect the calls.
 */
export function stubApi(routes: StubRoutes) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`Unexpected request in test: ${key}`);
    const reply = typeof route === 'function' ? route() : route;
    if (reply === 'pending') return new Promise<Response>(() => {});
    if (!('body' in reply)) return new Response(null, { status: reply.status });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Render the app (or given routes) at a path with a fresh query cache. */
export function renderApp(path: string, routes: RouteObject[] = appRoutes) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}
