import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import type { z } from 'zod';
import {
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_PROJECT_SETTINGS,
  allowedActions,
} from '@devspace/shared';
import type {
  AcceptInvitationResponseSchema,
  ActivityListResponseSchema,
  AuthResponse,
  CreateInvitationResponseSchema,
  ErrorResponse,
  HealthResponse,
  InvitationListResponseSchema,
  InvitationPreviewResponse,
  MemberListResponseSchema,
  MemberResponseSchema,
  MemberPermissions,
  ProjectDetail,
  ProjectMember,
  ProjectRole,
  Team,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
  User,
} from '@devspace/shared';
import { routes as appRoutes } from '../app/routes';

export const testUser: User = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: '2026-09-27T10:00:00.000Z',
};

/** A canned API answer. Bodies are typed with the shared contract. */
export type StubBody =
  | AuthResponse
  | HealthResponse
  | z.infer<typeof TeamResponseSchema>
  | z.infer<typeof TeamListResponseSchema>
  | z.infer<typeof TeamDetailResponseSchema>
  | z.infer<typeof ProjectListResponseSchema>
  | z.infer<typeof ProjectResponseSchema>
  | z.infer<typeof MemberListResponseSchema>
  | z.infer<typeof MemberResponseSchema>
  | z.infer<typeof InvitationListResponseSchema>
  | z.infer<typeof CreateInvitationResponseSchema>
  | InvitationPreviewResponse
  | z.infer<typeof AcceptInvitationResponseSchema>
  | z.infer<typeof ActivityListResponseSchema>;

export type StubReply =
  | { status: 200 | 201; body: StubBody }
  | { status: 204 }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 500 | 503;
      body: ErrorResponse | HealthResponse;
    }
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

// ---------- Teams and projects (Phase 3) ----------

export const testTeam: Team = {
  id: 'team-1',
  name: 'Core team',
  ownerId: testUser.id,
  isOwner: true,
  createdAt: '2026-09-27T10:00:00.000Z',
};

/** A project as the API would describe it to someone with this role and these permissions. */
export function testProject(
  role: ProjectRole = 'leader',
  overrides: Partial<ProjectDetail> = {},
): ProjectDetail {
  const myPermissions = overrides.myPermissions ?? DEFAULT_MEMBER_PERMISSIONS;
  return {
    id: 'project-1',
    name: 'Website',
    teamId: testTeam.id,
    teamName: testTeam.name,
    myRole: role,
    createdAt: '2026-09-27T10:00:00.000Z',
    settings: DEFAULT_PROJECT_SETTINGS,
    myPermissions,
    allowedActions: allowedActions(role, myPermissions),
    memberCount: 3,
    ...overrides,
  };
}

export function testMember(
  userId: string,
  name: string,
  role: ProjectRole,
  permissions: Partial<MemberPermissions> = {},
): ProjectMember {
  return {
    userId,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
    role,
    permissions: { ...DEFAULT_MEMBER_PERMISSIONS, ...permissions },
    joinedAt: '2026-09-27T10:00:00.000Z',
  };
}

/** The home page's lists, empty. */
export const emptyDashboard: StubRoutes = {
  'GET /api/projects': { status: 200, body: { projects: [] } },
  'GET /api/teams': { status: 200, body: { teams: [] } },
};

/** The JSON body sent with the first request matching "METHOD /path". */
export function requestBody(fetchMock: ReturnType<typeof stubApi>, key: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  );
  if (!call) throw new Error(`no request ${key}`);
  return JSON.parse(String(call[1]?.body));
}
