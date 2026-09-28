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
  CopyResponse,
  CopyUpdatePreview,
  CopyUpdateResponse,
  IdeLaunchResponse,
  CopyView,
  Comment,
  CommentResponse,
  CopyChangesResponse,
  SubmissionDetail,
  SubmissionFileResponse,
  SubmissionListResponse,
  SubmissionResponse,
  CreateInvitationResponseSchema,
  ErrorResponse,
  FileResponse,
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
  RepositoryResponseSchema,
  RepositoryStatus,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
  TreeResponse,
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
  | z.infer<typeof ActivityListResponseSchema>
  | z.infer<typeof RepositoryResponseSchema>
  | TreeResponse
  | FileResponse
  | CopyResponse
  | IdeLaunchResponse
  | CopyUpdatePreview
  | CopyUpdateResponse
  | CopyChangesResponse
  | SubmissionListResponse
  | SubmissionResponse
  | SubmissionFileResponse
  | CommentResponse;

export type StubReply =
  | { status: 200 | 201 | 202; body: StubBody }
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

// ---------- Repository (Phase 4) ----------

/** A repository status as GET /repository would describe it. */
export function testRepository(overrides: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    status: 'none',
    source: null,
    importUrl: null,
    error: null,
    lastCommit: null,
    ...overrides,
  };
}

// ---------- Copies and IDE (Phase 5) ----------

/** My copy as GET/POST …/copy would describe it. */
export function testCopy(overrides: Partial<CopyView> = {}): CopyView {
  return {
    id: '8f14e45f-ceea-467a-9575-000000000001',
    branchName: `copy/${testUser.id}`,
    containerStatus: 'none',
    createdAt: '2026-09-27T10:00:00.000Z',
    lastActiveAt: null,
    behind: false,
    pendingConflictPaths: [],
    unresolvedPaths: [],
    helpers: [],
    ...overrides,
  };
}

// ---------- Submissions (Phase 6) ----------

/** A submission as GET /submissions/:id would describe it, by default authored by someone else. */
export function testSubmission(overrides: Partial<SubmissionDetail> = {}): SubmissionDetail {
  return {
    id: 'sub-1',
    title: 'Add the login page',
    status: 'open',
    author: { id: 'user-2', name: 'Grace Hopper' },
    version: 1,
    fileCount: 1,
    commentCount: 0,
    approvals: 0,
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    description: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    rejectReason: null,
    closedAt: null,
    files: [{ path: 'src/app.ts', change: 'modified' }],
    reviews: [],
    comments: [],
    viewerActions: [],
    conflictPaths: [],
    mergedSha: null,
    mergedBy: null,
    mergedAt: null,
    revertedSha: null,
    revertedBy: null,
    revertedAt: null,
    mergeBlocker: null,
    ...overrides,
  };
}

/** A comment on a submission, by default a general one by the test user. */
export function testComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    author: { id: testUser.id, name: testUser.name },
    parentId: null,
    path: null,
    side: null,
    line: null,
    startLine: null,
    version: 1,
    body: 'Looks good',
    suggestion: null,
    suggestionStatus: null,
    outdated: false,
    createdAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}
