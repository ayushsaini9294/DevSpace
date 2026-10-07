import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import type { z } from 'zod';
import {
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_PROJECT_SETTINGS,
  TEMPLATES,
  allowedActions,
} from '@devspace/shared';
import type {
  GithubAccountView,
  GithubConnectStartResponseSchema,
  GithubLinkView,
  GithubRepoListResponse,
  ProjectGithubView,
  GettingStartedView,
  TemplateList,
  AiConnectionView,
  AiPreferences,
  AiConnectStartResponse,
  AiModelListResponse,
  AiNoticeAcceptResponse,
  AiReviewListResponse,
  AiReviewView,
  IdeReviewResponse,
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
  TaskListResponse,
  TaskResponse,
  TaskView,
  MarkNotificationsReadResponse,
  NotificationListResponse,
  NotificationView,
  Preferences,
  PresenceListResponse,
  PresenceView,
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
  | CommentResponse
  | TaskListResponse
  | TaskResponse
  | NotificationListResponse
  | MarkNotificationsReadResponse
  | PresenceListResponse
  | Preferences
  | AiConnectionView
  | AiPreferences
  | AiConnectStartResponse
  | AiNoticeAcceptResponse
  | AiModelListResponse
  | AiReviewListResponse
  | IdeReviewResponse
  | TemplateList
  | GettingStartedView
  | GithubAccountView
  | z.infer<typeof GithubConnectStartResponseSchema>
  | GithubRepoListResponse
  | ProjectGithubView;

export type StubReply =
  | { status: 200 | 201 | 202; body: StubBody }
  | { status: 204 }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 429 | 500 | 503;
      body: ErrorResponse | HealthResponse;
    }
  | 'pending';

export type StubRoutes = Record<string, StubReply | (() => StubReply)>;

export const loggedIn: StubReply = { status: 200, body: { user: testUser } };
export const loggedOut: StubReply = {
  status: 401,
  body: { error: 'unauthenticated', message: 'Log in first' },
};
/** A 429 as the API sends it when a rate limit is hit (Phase 14). */
export const rateLimited: StubReply = {
  status: 429,
  body: { error: 'rate_limited', message: 'Too many tries. Please wait a minute and try again.' },
};

export const healthOk: StubReply = { status: 200, body: { ok: true, db: true, redis: true } };

/**
 * Answers for requests every logged-in page makes (the bell, the Team panel, my preferences),
 * used when a test gives none: nothing to show.
 */
function defaultReply(key: string): StubReply | null {
  if (key === 'GET /api/notifications') {
    return { status: 200, body: { notifications: [], unreadCount: 0, nextCursor: null } };
  }
  if (key === 'GET /api/me/preferences') return { status: 200, body: { shareOpenFile: true } };
  if (/^GET \/api\/projects\/[^/]+\/presence$/.test(key)) {
    return { status: 200, body: { members: [] } };
  }
  if (key === 'GET /api/templates') return { status: 200, body: [...TEMPLATES] };
  // The getting-started card stays out of the way unless a test gives an answer.
  if (/^GET \/api\/projects\/[^/]+\/getting-started$/.test(key)) return 'pending';
  // GitHub (Phase 13) isn't set up unless a test says so. (Not 'pending': a project's GitHub
  // status sits under the project's key, and refreshing the project waits for it.)
  if (/^GET \/api\/projects\/[^/]+\/github$/.test(key)) {
    return {
      status: 200,
      body: testProjectGithub({
        configured: false,
        connected: false,
        installUrl: null,
        canPublish: false,
        canManage: false,
        canUnlink: false,
      }),
    };
  }
  if (key === 'GET /api/github/account') {
    return {
      status: 200,
      body: testGithubAccount({
        configured: false,
        connected: false,
        login: null,
        connectedAt: null,
        installUrl: null,
        appInstalled: null,
      }),
    };
  }
  return null;
}

/**
 * Replace fetch with a tiny router keyed by "METHOD /path". Unknown requests fail the test.
 * Returns the mock so tests can inspect the calls.
 */
export function stubApi(routes: StubRoutes) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const route = routes[key] ?? defaultReply(key);
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
    template: null,
    importUrl: null,
    error: null,
    lastCommit: null,
    ...overrides,
  };
}

// ---------- Copies and IDE (Phase 5) ----------

/** The id of `testCopy()`. */
export const TEST_COPY_ID = '8f14e45f-ceea-467a-9575-000000000001';

/** `testCopy()`'s own IDE address (Phase 14: every copy's IDE has its own), as the API gives it. */
export const TEST_IDE_ORIGIN = `http://${TEST_COPY_ID}.ide.localhost:3100`;

/** My copy as GET/POST …/copy would describe it. */
export function testCopy(overrides: Partial<CopyView> = {}): CopyView {
  return {
    id: TEST_COPY_ID,
    branchName: `copy/${testUser.id}`,
    containerStatus: 'none',
    createdAt: '2026-09-27T10:00:00.000Z',
    lastActiveAt: null,
    behind: false,
    pendingConflictPaths: [],
    unresolvedPaths: [],
    helpers: [],
    packagesChanged: false,
    aiAssistant: { ready: true, reason: null },
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
    task: null,
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

// ---------- Tasks (Phase 8) ----------

/** A task as GET /tasks would describe it: in To do, assigned to the test user. */
export function testTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task-1',
    title: 'Build the login page',
    description: '',
    status: 'todo',
    dueDate: null,
    position: 1,
    assignees: [{ id: testUser.id, name: testUser.name }],
    createdBy: { id: 'user-2', name: 'Grace Hopper' },
    doneConfirmPending: false,
    reopenNote: null,
    linkedSubmissions: [],
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    completedAt: null,
    viewerActions: [],
    ...overrides,
  };
}

// ---------- Presence and notifications (Phase 9) ----------

/** A member's presence, by default Grace, active and editing src/app.ts. */
export function testPresence(overrides: Partial<PresenceView> = {}): PresenceView {
  return {
    user: { id: 'user-2', name: 'Grace Hopper' },
    state: 'active',
    file: 'src/app.ts',
    copyOwner: null,
    lastSeenAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

/** An unread notification: Grace approved my submission. */
export function testNotification(
  overrides: Partial<Omit<NotificationView, 'type' | 'data'>> = {},
): NotificationView {
  return {
    id: 'notification-1',
    type: 'submission.reviewed',
    project: { id: 'project-1', name: 'Website' },
    data: {
      submissionId: 'sub-1',
      title: 'Add the login page',
      actorName: 'Grace Hopper',
      decision: 'approved',
    },
    readAt: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

// ---------- AI review (Phase 10) ----------

/** My OpenRouter connection: connected, notice already accepted, 47 of 50 free requests left. */
export function testAiConnection(overrides: Partial<AiConnectionView> = {}): AiConnectionView {
  return {
    connected: true,
    provider: 'openrouter',
    keyHint: 'a1b2',
    connectedAt: '2026-09-28T09:00:00.000Z',
    freeRequestsToday: { used: 3, limit: 50, remaining: 47 },
    noticeAcceptedAt: '2026-09-28T09:00:00.000Z',
    ...overrides,
  };
}

/** One model's review of sub-1 version 1, asked by the test user: done, with no findings. */
export function testAiReview(overrides: Partial<AiReviewView> = {}): AiReviewView {
  return {
    id: 'ai-review-1',
    submissionId: 'sub-1',
    version: 1,
    requestedBy: { id: testUser.id, name: testUser.name },
    source: 'auto',
    model: 'qwen/qwen3.8-27b:free',
    requestedModel: 'qwen/qwen3.8-27b:free',
    isFree: true,
    status: 'done',
    findings: [],
    parseError: false,
    raw: null,
    error: null,
    errorCode: null,
    createdAt: '2026-09-28T10:00:00.000Z',
    finishedAt: '2026-09-28T10:01:00.000Z',
    ...overrides,
  };
}

// ---------- GitHub (Phase 13) ----------

export const GITHUB_INSTALL_URL = 'https://github.com/apps/devspace/installations/new';

/** My GitHub account: GitHub is set up here, and I connected as "ada" with the app installed. */
export function testGithubAccount(overrides: Partial<GithubAccountView> = {}): GithubAccountView {
  return {
    configured: true,
    connected: true,
    login: 'ada',
    connectedAt: '2026-10-01T09:00:00.000Z',
    installUrl: GITHUB_INSTALL_URL,
    appInstalled: true,
    ...overrides,
  };
}

/** A project's GitHub link: ada/website, private, publish once, up to date. */
export function testGithubLink(overrides: Partial<GithubLinkView> = {}): GithubLinkView {
  return {
    repoFullName: 'ada/website',
    htmlUrl: 'https://github.com/ada/website',
    private: true,
    mode: 'publish_once',
    status: 'ok',
    statusReason: null,
    lastPushedSha: 'c'.repeat(40),
    lastPushedAt: '2026-10-01T10:00:00.000Z',
    behind: false,
    setUpBy: { id: testUser.id, name: testUser.name },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

/** GET …/github for a leader with GitHub connected, before publishing. */
export function testProjectGithub(overrides: Partial<ProjectGithubView> = {}): ProjectGithubView {
  return {
    configured: true,
    connected: true,
    installUrl: GITHUB_INSTALL_URL,
    link: null,
    canPublish: true,
    canManage: true,
    canUnlink: true,
    emailWarning: { names: [] },
    ...overrides,
  };
}
