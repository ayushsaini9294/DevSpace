import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiConnectFinishRequestSchema,
  CreateAiReviewRequestSchema,
  DEFAULT_MEMBER_PERMISSIONS,
  UpdateAiPreferencesRequestSchema,
  UpdateProjectSettingsRequestSchema,
  groupAiFindings,
  type AiPreferences,
  type AiReviewListResponse,
  type AiReviewView,
  type NotificationView,
  type ProjectDetail,
} from '@devspace/shared';
import { aiKeys, browser } from '../lib/ai';
import { targetsFor } from '../lib/live';
import { describeNotification, notificationUrl } from '../lib/notifications';
import {
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testAiConnection,
  testAiReview,
  testProject,
  testSubmission,
  type StubReply,
  type StubRoutes,
} from '../test/utils';

// Monaco doesn't run in jsdom: the lazily loaded diff becomes plain text.
vi.mock('../components/code/DiffViewer', () => ({
  default: ({ path }: { path: string }) => <div data-testid="diff-mock">{path}</div>,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const S = `${P}/submissions/sub-1`;

function calls(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  ).length;
}

function sequence(...replies: StubReply[]): () => StubReply {
  let n = 0;
  return () => replies[Math.min(n++, replies.length - 1)]!;
}

// ---------- Settings → AI ----------

function preferences(overrides: Partial<AiPreferences> = {}): AiPreferences {
  return {
    allowPaid: false,
    assistantUsageToday: { day: '2026-09-30', requests: 0, models: [] },
    ...overrides,
  };
}

describe('AI settings: the IDE assistant', () => {
  it('shows today’s assistant use and the note about helping leads', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': { status: 200, body: testAiConnection() },
      'GET /api/ai/preferences': {
        status: 200,
        body: preferences({
          assistantUsageToday: {
            day: '2026-09-30',
            requests: 5,
            models: [
              { model: 'qwen/qwen3.8-27b:free', requests: 4 },
              { model: 'openrouter/free', requests: 1 },
            ],
          },
        }),
      },
    });
    renderApp('/settings/ai');

    const usage = await screen.findByTestId('ai-assistant-usage');
    expect(usage).toHaveTextContent('Assistant use today (UTC): 5 requests.');
    expect(usage).toHaveTextContent('qwen/qwen3.8-27b:free: 4 requests');
    expect(usage).toHaveTextContent('openrouter/free: 1 request');
    expect(screen.getByTestId('ai-helper-note')).toHaveTextContent('they can never see your key');
    expect(screen.getByRole('heading', { level: 2, name: 'AI settings' })).toBeInTheDocument();
    // Already accepted: no notice.
    expect(screen.queryByTestId('ai-notice')).not.toBeInTheDocument();
  });

  it('turns paid models on for the assistant', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': { status: 200, body: testAiConnection() },
      'GET /api/ai/preferences': { status: 200, body: preferences() },
      'PATCH /api/ai/preferences': { status: 200, body: preferences({ allowPaid: true }) },
    });
    renderApp('/settings/ai');

    const toggle = await screen.findByRole('switch', {
      name: 'Allow paid models in the IDE assistant (uses your OpenRouter credits)',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription(/only use free models/);
    expect(screen.getByTestId('ai-assistant-usage')).toHaveTextContent('no requests yet');

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(
      UpdateAiPreferencesRequestSchema.parse(requestBody(fetchMock, 'PATCH /api/ai/preferences')),
    ).toEqual({ allowPaid: true });
  });

  it('shows an error when the switch can’t be saved', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': { status: 200, body: testAiConnection() },
      'GET /api/ai/preferences': { status: 200, body: preferences({ allowPaid: true }) },
      'PATCH /api/ai/preferences': {
        status: 500,
        body: { error: 'internal', message: 'Something went wrong' },
      },
    });
    renderApp('/settings/ai');
    const toggle = await screen.findByTestId('ai-allow-paid');
    await user.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change this setting.');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('lets me accept the AI notice here, which the assistant needs', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': {
        status: 200,
        body: testAiConnection({ noticeAcceptedAt: null }),
      },
      'GET /api/ai/preferences': { status: 200, body: preferences() },
      'POST /api/ai/notice/accept': {
        status: 200,
        body: { noticeAcceptedAt: '2026-09-30T10:00:00.000Z' },
      },
    });
    renderApp('/settings/ai');

    const notice = await screen.findByTestId('ai-notice');
    expect(notice).toHaveTextContent('IDE’s AI assistant send your code');
    await user.click(within(notice).getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(screen.queryByTestId('ai-notice')).not.toBeInTheDocument());
    expect(calls(fetchMock, 'POST /api/ai/notice/accept')).toBe(1);
  });
});

describe('AI settings page', () => {
  it('connects: asks the API for OpenRouter’s address and goes there', async () => {
    const leave = vi.spyOn(browser, 'leaveFor').mockImplementation(() => {});
    const url = 'https://openrouter.ai/auth?callback_url=x&code_challenge=y';
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': {
        status: 200,
        body: testAiConnection({
          connected: false,
          keyHint: null,
          connectedAt: null,
          freeRequestsToday: null,
          noticeAcceptedAt: null,
        }),
      },
      'POST /api/ai/openrouter/start': { status: 200, body: { url } },
      'GET /api/ai/preferences': { status: 200, body: preferences() },
    });
    renderApp('/settings/ai');

    expect(await screen.findByTestId('ai-connection-status')).toHaveTextContent('Not connected');
    await userEvent.click(screen.getByRole('button', { name: 'Connect OpenRouter' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith(url));
  });

  it('shows the key hint and free requests, and disconnects', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/ai/connection': sequence(
        { status: 200, body: testAiConnection() },
        {
          status: 200,
          body: testAiConnection({ connected: false, keyHint: null, freeRequestsToday: null }),
        },
      ),
      'DELETE /api/ai/connection': { status: 204 },
      'GET /api/ai/preferences': { status: 200, body: preferences() },
    });
    renderApp('/settings/ai');

    expect(await screen.findByTestId('ai-connection-status')).toHaveTextContent('Connected');
    expect(screen.getByText(/Key ending in …a1b2/)).toBeInTheDocument();
    expect(screen.getByTestId('ai-free-requests')).toHaveTextContent(
      '47 of 50 free requests left today',
    );
    expect(screen.getByRole('link', { name: 'OpenRouter settings' })).toHaveAttribute(
      'href',
      'https://openrouter.ai/settings/keys',
    );

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(screen.getByTestId('ai-connection-status')).toHaveTextContent('Not connected'),
    );
    expect(calls(fetchMock, 'DELETE /api/ai/connection')).toBe(1);
    expect(screen.getByText('Disconnected. DevSpace no longer has your key.')).toBeInTheDocument();
  });

  it('is linked from the user menu', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/projects': { status: 200, body: { projects: [] } },
      'GET /api/teams': { status: 200, body: { teams: [] } },
    });
    renderApp('/');
    await user.click(await screen.findByTestId('current-user'));
    expect(screen.getByRole('link', { name: 'AI settings' })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
  });
});

describe('the OpenRouter callback page', () => {
  it('finishes connecting once, then shows the settings page connected', async () => {
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'POST /api/ai/openrouter/finish': { status: 200, body: testAiConnection() },
      'GET /api/ai/connection': { status: 200, body: testAiConnection() },
      'GET /api/ai/preferences': { status: 200, body: preferences() },
    });
    const { router } = renderApp('/settings/ai/callback?code=the-code&state=the-state');

    expect(await screen.findByText('OpenRouter connected.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/ai');
    expect(screen.getByTestId('ai-connection-status')).toHaveTextContent('Connected');
    expect(
      AiConnectFinishRequestSchema.parse(requestBody(fetchMock, 'POST /api/ai/openrouter/finish')),
    ).toEqual({ code: 'the-code', state: 'the-state' });
    expect(calls(fetchMock, 'POST /api/ai/openrouter/finish')).toBe(1);
  });

  it('explains an expired or used link', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'POST /api/ai/openrouter/finish': {
        status: 400,
        body: { error: 'invalid_state', message: 'Bad state' },
      },
    });
    renderApp('/settings/ai/callback?code=c&state=s');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This connection link has expired or was already used.',
    );
    expect(screen.getByRole('link', { name: 'Back to AI settings' })).toBeInTheDocument();
  });

  it('says so when OpenRouter sent no code', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': loggedIn });
    renderApp('/settings/ai/callback?error=access_denied');
    expect(await screen.findByRole('alert')).toHaveTextContent('didn’t send DevSpace a code');
    expect(calls(fetchMock, 'POST /api/ai/openrouter/finish')).toBe(0);
  });
});

// ---------- Project switch ----------

describe('the project’s AI switch', () => {
  it('is off by default and a leader turns it on', async () => {
    const user = userEvent.setup();
    const project = testProject('leader');
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      [`GET ${P}`]: { status: 200, body: { project } },
      [`PATCH ${P}/settings`]: {
        status: 200,
        body: { project: { ...project, settings: { ...project.settings, aiReviewEnabled: true } } },
      },
    });
    renderApp('/projects/project-1/settings');

    const box = await screen.findByRole('checkbox', {
      name: 'Allow AI (AI review and the IDE assistant; sends code to AI providers)',
    });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(/outside AI providers/);
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(
      UpdateProjectSettingsRequestSchema.parse(requestBody(fetchMock, `PATCH ${P}/settings`)),
    ).toEqual({ aiReviewEnabled: true });
  });
});

// ---------- Review page ----------

/** A member with the "AI cross-review" permission, in a project with AI review switched on. */
function aiProject(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  const project = testProject('member', {
    myPermissions: { ...DEFAULT_MEMBER_PERMISSIONS, aiReview: true },
    ...overrides,
  });
  return { ...project, settings: { ...project.settings, aiReviewEnabled: true } };
}

function list(reviews: AiReviewView[], running = false): AiReviewListResponse {
  return {
    version: 1,
    reviews,
    groups: groupAiFindings(reviews.filter((r) => r.status === 'done' && r.version === 1)),
    running,
  };
}

function reviewRoutes(extra: StubRoutes, project: ProjectDetail = aiProject()): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    [`GET ${S}`]: { status: 200, body: { submission: testSubmission() } },
    [`GET ${S}/file?path=${encodeURIComponent('src/app.ts')}`]: {
      status: 200,
      body: {
        path: 'src/app.ts',
        change: 'modified',
        base: { kind: 'text', content: 'a\n' },
        head: { kind: 'text', content: 'b\n' },
      },
    },
    'GET /api/ai/connection': { status: 200, body: testAiConnection() },
    ...extra,
  };
}

function aiSection() {
  return screen.getByRole('region', { name: 'AI review' });
}

describe('the review page’s AI review section', () => {
  it('says AI review is off and asks nothing while the switch is off', async () => {
    const fetchMock = stubApi(reviewRoutes({}, testProject('member')));
    renderApp('/projects/project-1/submissions/sub-1');
    await screen.findByText('Add the login page', {}, { timeout: 4000 });
    expect(within(aiSection()).getByText(/AI review is off for this project/)).toBeInTheDocument();
    expect(calls(fetchMock, `GET ${S}/ai-reviews`)).toBe(0);
    expect(calls(fetchMock, 'GET /api/ai/connection')).toBe(0);
  });

  it('shows the one-time notice first, then starts a free cross-review', async () => {
    const user = userEvent.setup();
    const queued = [
      testAiReview({ id: 'r1', status: 'queued', finishedAt: null }),
      testAiReview({
        id: 'r2',
        status: 'running',
        model: 'google/gemma-4-31b-it:free',
        requestedModel: 'google/gemma-4-31b-it:free',
        finishedAt: null,
      }),
    ];
    const fetchMock = stubApi(
      reviewRoutes({
        'GET /api/ai/connection': {
          status: 200,
          body: testAiConnection({ noticeAcceptedAt: null }),
        },
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
        'POST /api/ai/notice/accept': {
          status: 200,
          body: { noticeAcceptedAt: '2026-09-28T11:00:00.000Z' },
        },
        [`POST ${S}/ai-reviews`]: { status: 201, body: list(queued, true) },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    const button = await screen.findByRole(
      'button',
      { name: 'Cross-review with AI' },
      { timeout: 4000 },
    );
    expect(within(aiSection()).getByText(/47 of 50 free requests left today/)).toBeInTheDocument();
    await user.click(button);

    const dialog = screen.getByRole('dialog', { name: 'Before your first AI review' });
    expect(calls(fetchMock, `POST ${S}/ai-reviews`)).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'I understand, continue' }));

    await waitFor(() => expect(calls(fetchMock, `POST ${S}/ai-reviews`)).toBe(1));
    expect(calls(fetchMock, 'POST /api/ai/notice/accept')).toBe(1);
    expect(requestBody(fetchMock, `POST ${S}/ai-reviews`)).toEqual({});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const statuses = await screen.findAllByTestId('ai-model-status');
    expect(statuses.map((s) => s.dataset.status)).toEqual(['queued', 'running']);
    expect(statuses[1]).toHaveTextContent('google/gemma-4-31b-it:free');
    expect(screen.getByRole('button', { name: 'Cross-review with AI' })).toBeDisabled();
    expect(screen.getByText(/Your cross-review is running/)).toBeInTheDocument();
  });

  it('groups findings by file, highlights agreement, and shows AI text as plain text', async () => {
    const reviews = [
      testAiReview({
        id: 'r1',
        findings: [
          {
            path: 'src/app.ts',
            line: 10,
            severity: 'high',
            title: '<img src=x onerror="alert(1)">Null check',
            detail: '**bold** <script>alert(2)</script>',
          },
          { path: 'src/util.ts', line: 3, severity: 'low', title: 'Naming', detail: 'Rename x' },
        ],
      }),
      testAiReview({
        id: 'r2',
        model: 'nvidia/nemotron-3-super-120b-a12b:free',
        requestedModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        findings: [
          {
            path: 'src/app.ts',
            line: 12,
            severity: 'medium',
            title: 'Possible null',
            detail: 'value may be null',
          },
        ],
      }),
      testAiReview({
        id: 'r3',
        model: 'google/gemma-4-31b-it:free',
        requestedModel: 'google/gemma-4-31b-it:free',
        status: 'failed',
        errorCode: 'daily_limit',
        error: 'Free daily limit reached (50/day)',
        finishedAt: '2026-09-28T10:02:00.000Z',
      }),
    ];
    stubApi(reviewRoutes({ [`GET ${S}/ai-reviews`]: { status: 200, body: list(reviews) } }));
    renderApp('/projects/project-1/submissions/sub-1');

    const groups = await screen.findAllByTestId('ai-finding-group', {}, { timeout: 4000 });
    expect(groups).toHaveLength(2);
    const [agreed, single] = groups as [HTMLElement, HTMLElement];
    expect(agreed.dataset.agreed).toBe('true');
    expect(agreed).toHaveTextContent('Agreed by 2 models');
    expect(agreed).toHaveTextContent('Lines 10–12');
    expect(agreed).toHaveTextContent('High severity');
    expect(agreed).toHaveTextContent('nvidia/nemotron-3-super-120b-a12b:free');
    expect(single.dataset.agreed).toBe('false');
    expect(single).toHaveTextContent('Naming');

    // Grouped under each file's heading.
    const section = aiSection();
    expect(
      within(section).getByRole('heading', { level: 4, name: 'src/app.ts' }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('heading', { level: 4, name: 'src/util.ts' }),
    ).toBeInTheDocument();

    // Untrusted text stays text.
    expect(
      within(agreed).getByText('<img src=x onerror="alert(1)">Null check'),
    ).toBeInTheDocument();
    expect(within(agreed).getByText('**bold** <script>alert(2)</script>')).toBeInTheDocument();
    expect(section.querySelector('img, script, strong > b')).toBeNull();

    // Per-model status, the fallback, and a clear failure.
    const statuses = screen.getAllByTestId('ai-model-status');
    expect(statuses.map((s) => s.dataset.status)).toEqual(['done', 'done', 'failed']);
    expect(statuses[1]).toHaveTextContent(
      'answered instead of nvidia/nemotron-3-ultra-550b-a55b:free',
    );
    expect(statuses[2]).toHaveTextContent('OpenRouter’s free daily limit is used up');
    expect(statuses[2]).toHaveTextContent('Free daily limit reached (50/day)');
  });

  it('shows an unreadable answer as plain text', async () => {
    const reviews = [testAiReview({ parseError: true, raw: '<b>not json</b>', findings: [] })];
    stubApi(reviewRoutes({ [`GET ${S}/ai-reviews`]: { status: 200, body: list(reviews) } }));
    renderApp('/projects/project-1/submissions/sub-1');
    const status = await screen.findByTestId('ai-model-status', {}, { timeout: 4000 });
    expect(status).toHaveTextContent('wasn’t in the expected format');
    expect(within(status).getByText('<b>not json</b>')).toBeInTheDocument();
    expect(status.querySelector('b')).toBeNull();
  });

  it('asks for an explicit credits confirmation before a paid model', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      reviewRoutes({
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
        'GET /api/ai/models': {
          status: 200,
          body: {
            models: [
              { id: 'qwen/qwen3.8-27b:free', name: 'Qwen 3.8', isFree: true, contextLength: 1000 },
              { id: 'acme/big-model', name: 'Acme Big', isFree: false, contextLength: null },
            ],
            defaults: ['qwen/qwen3.8-27b:free'],
            fallbacks: [],
          },
        },
        [`POST ${S}/ai-reviews`]: { status: 201, body: list([], true) },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    await user.click(await screen.findByText('Advanced: choose models', {}, { timeout: 4000 }));
    await user.click(await screen.findByRole('checkbox', { name: /Acme Big/ }));
    const run = screen.getByRole('button', { name: 'Cross-review with chosen models' });
    expect(run).toBeDisabled();
    expect(screen.getByText(/uses your OpenRouter credits, and OpenRouter/)).toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', { name: 'I understand this uses my OpenRouter credits' }),
    );
    await user.click(run);
    await waitFor(() => expect(calls(fetchMock, `POST ${S}/ai-reviews`)).toBe(1));
    expect(
      CreateAiReviewRequestSchema.parse(requestBody(fetchMock, `POST ${S}/ai-reviews`)),
    ).toEqual({ models: ['acme/big-model'], confirmPaid: true });
  });

  it.each([
    ['ai_review_running', 'You already have an AI cross-review running'],
    ['not_connected', 'Connect your OpenRouter account first'],
    ['ai_disabled', 'AI review is turned off for this project'],
    ['paid_confirmation_required', 'would use your OpenRouter credits'],
  ])('explains %s', async (error, text) => {
    const user = userEvent.setup();
    stubApi(
      reviewRoutes({
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
        [`POST ${S}/ai-reviews`]: { status: 409, body: { error, message: 'No' } },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    await user.click(
      await screen.findByRole('button', { name: 'Cross-review with AI' }, { timeout: 4000 }),
    );
    expect(await within(aiSection()).findByRole('alert')).toHaveTextContent(text);
  });

  it('asks a member without an OpenRouter account to connect first', async () => {
    stubApi(
      reviewRoutes({
        'GET /api/ai/connection': {
          status: 200,
          body: testAiConnection({ connected: false, keyHint: null, freeRequestsToday: null }),
        },
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    expect(
      await screen.findByRole(
        'link',
        { name: 'connect your OpenRouter account' },
        { timeout: 4000 },
      ),
    ).toHaveAttribute('href', '/settings/ai');
    expect(screen.queryByRole('button', { name: 'Cross-review with AI' })).not.toBeInTheDocument();
  });

  it('reviews with my IDE AI: writes the folder, then opens my IDE', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      reviewRoutes({
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
        [`POST ${S}/ide-review`]: {
          status: 201,
          body: {
            folder: '.devspace/reviews/sub-1',
            files: ['REVIEW.md', 'changes.diff', 'findings.md'],
            idePath: '/projects/project-1/ide',
          },
        },
        // The IDE page starts; its answers don't matter here.
        [`POST ${P}/copy/ide`]: 'pending',
      }),
    );
    const { router } = renderApp('/projects/project-1/submissions/sub-1');

    const button = await screen.findByRole(
      'button',
      { name: 'Review with my IDE AI' },
      { timeout: 4000 },
    );
    expect(within(aiSection()).getByText('.devspace/reviews/sub-1')).toBeInTheDocument();
    expect(within(aiSection()).getByText('DevSpace: Send review findings')).toBeInTheDocument();
    await user.click(button);
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/project-1/ide'));
    expect(calls(fetchMock, `POST ${S}/ide-review`)).toBe(1);
  });

  it('never follows an idePath outside the app', async () => {
    const user = userEvent.setup();
    stubApi(
      reviewRoutes({
        [`GET ${S}/ai-reviews`]: { status: 200, body: list([]) },
        [`POST ${S}/ide-review`]: {
          status: 201,
          body: { folder: 'x', files: [], idePath: '//evil.example/ide' },
        },
        [`POST ${P}/copy/ide`]: 'pending',
      }),
    );
    const { router } = renderApp('/projects/project-1/submissions/sub-1');
    await user.click(
      await screen.findByRole('button', { name: 'Review with my IDE AI' }, { timeout: 4000 }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/project-1/ide'));
  });

  it('lets a member without the permission read reviews only', async () => {
    const project = aiProject({ allowedActions: ['project.view'] });
    const fetchMock = stubApi(
      reviewRoutes(
        { [`GET ${S}/ai-reviews`]: { status: 200, body: list([testAiReview()]) } },
        project,
      ),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    expect(await screen.findByTestId('ai-model-status', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/You don’t have permission to ask for AI reviews/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cross-review with AI' })).not.toBeInTheDocument();
    expect(calls(fetchMock, 'GET /api/ai/connection')).toBe(0);
  });
});

// ---------- Live updates and notifications ----------

describe('AI live updates and notifications', () => {
  it('refreshes a submission’s AI reviews on `ai-reviews:<id>`', () => {
    expect(targetsFor('project-1', 'ai-reviews:sub-1', 'user-1')).toEqual([
      { queryKey: aiKeys.reviews('project-1', 'sub-1') },
      { queryKey: aiKeys.connection },
    ]);
  });

  it('describes ai_review.finished and links to the submission', () => {
    const base = {
      id: 'n1',
      project: { id: 'project-1', name: 'Website' },
      readAt: null,
      createdAt: '2026-09-28T10:00:00.000Z',
    };
    const n = (done: number, failed: number, findingCount: number): NotificationView => ({
      ...base,
      type: 'ai_review.finished',
      data: { submissionId: 'sub-1', title: 'Add login', done, failed, findingCount },
    });
    expect(describeNotification(n(2, 1, 4))).toBe(
      'The AI review of “Add login” finished: 4 findings (1 model failed)',
    );
    expect(describeNotification(n(3, 0, 0))).toBe(
      'The AI review of “Add login” finished: no findings',
    );
    expect(describeNotification(n(0, 3, 0))).toBe('The AI review of “Add login” failed');
    expect(notificationUrl(n(1, 0, 1))).toBe('/projects/project-1/submissions/sub-1');
  });
});
