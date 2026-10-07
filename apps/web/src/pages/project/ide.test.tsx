import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAssistantStatus, ProjectDetail, RepositoryStatus } from '@devspace/shared';
import {
  loggedIn,
  renderApp,
  stubApi,
  testCopy,
  TEST_IDE_ORIGIN,
  testProject,
  testRepository,
  type StubReply,
  type StubRoutes,
} from '../../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const LAUNCH = `POST ${P}/copy/ide/launch`;
const readyRepository = testRepository({ status: 'ready', source: 'empty' });
const running = testCopy({ containerStatus: 'running' });
const launchUrl = (ticket: string) => `${TEST_IDE_ORIGIN}/ide-launch?ticket=${ticket}`;

/** A launch endpoint that hands out a new ticket each call, like the real single-use one. */
function freshTickets(): () => StubReply {
  let n = 0;
  return () => {
    n += 1;
    return { status: 200, body: { url: launchUrl(`t${n}`) } };
  };
}

function overviewRoutes(project: ProjectDetail, repository: RepositoryStatus): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    [`GET ${P}/repository`]: { status: 200, body: { repository } },
  };
}

function ideRoutes(extra: StubRoutes): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project: testProject('member') } },
    ...extra,
  };
}

function calls(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  ).length;
}

/**
 * Wait for the Open IDE link with a cheap text query, then check its role once. A polling
 * findByRole re-runs the costly accessibility checks on every DOM change, which on the file's
 * first (cold) render slows the page it waits for past the 1 s limit.
 */
async function findOpenIdeLink() {
  await screen.findByText('Open IDE');
  return screen.getByRole('link', { name: 'Open IDE' });
}

describe('Open IDE button', () => {
  it.each(['leader', 'co_leader', 'member'] as const)(
    'is shown to a %s once the repository is ready',
    async (role) => {
      stubApi(overviewRoutes(testProject(role), readyRepository));
      renderApp('/projects/project-1');
      expect(await findOpenIdeLink()).toHaveAttribute('href', '/projects/project-1/ide');
    },
  );

  it.each(['none', 'importing', 'failed'] as const)(
    'is hidden while the repository is %s',
    async (status) => {
      stubApi(
        overviewRoutes(
          testProject('member'),
          testRepository({ status, importUrl: 'https://github.com/a/b' }),
        ),
      );
      renderApp('/projects/project-1');
      expect(await screen.findByRole('heading', { name: 'Repository' })).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('Loading the repository…')).toBeNull());
      expect(screen.queryByRole('link', { name: 'Open IDE' })).not.toBeInTheDocument();
    },
  );

  it('is hidden without project.view (the page would not load for non-members anyway)', async () => {
    stubApi(overviewRoutes(testProject('member', { allowedActions: [] }), readyRepository));
    renderApp('/projects/project-1');
    expect(await screen.findByRole('link', { name: 'Browse files' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open IDE' })).not.toBeInTheDocument();
  });

  it('opens the IDE page', async () => {
    const user = userEvent.setup();
    stubApi({
      ...overviewRoutes(testProject('member'), readyRepository),
      [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
      [LAUNCH]: freshTickets(),
    });
    const { router } = renderApp('/projects/project-1');
    await user.click(await findOpenIdeLink());
    expect(router.state.location.pathname).toBe('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toBeInTheDocument();
  });
});

describe('IDE page', () => {
  it('frames a fresh launch URL on the IDE site when running, with clipboard access and a way back', async () => {
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: freshTickets(),
      }),
    );
    renderApp('/projects/project-1/ide');

    const frame = await screen.findByTitle('VS Code for Website');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', launchUrl('t1'));
    expect(frame).toHaveAttribute('allow', 'clipboard-read; clipboard-write');
    expect(frame).not.toHaveAttribute('sandbox');
    expect(screen.getByRole('link', { name: '← Back to the project' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
    // One start and one ticket, even though the page's effects could run twice.
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(1);
    expect(calls(fetchMock, LAUNCH)).toBe(1);
    const launch = fetchMock.mock.calls.find(([url]) => String(url) === `${P}/copy/ide/launch`);
    expect(launch?.[1]?.body).toBe('{}');
  });

  it('asks for a new ticket on Reload IDE', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: freshTickets(),
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t1'));

    await user.click(screen.getByRole('button', { name: 'Reload IDE' }));
    await waitFor(() =>
      expect(screen.getByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t2')),
    );
    expect(calls(fetchMock, LAUNCH)).toBe(2);
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(1);
  });

  it('asks for a new ticket each time the page opens', async () => {
    const launch = freshTickets();
    const routes = ideRoutes({
      [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
      [LAUNCH]: launch,
      [`GET ${P}/repository`]: { status: 200, body: { repository: readyRepository } },
    });
    stubApi(routes);
    const first = renderApp('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t1'));

    // Leave and come back, in the same app and cache: the used ticket is never reused.
    await act(() => first.router.navigate('/projects/project-1'));
    expect(await findOpenIdeLink()).toBeInTheDocument();
    await act(() => first.router.navigate('/projects/project-1/ide'));
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t2'));
  });

  it('shows a loading state while starting and polls until running', async () => {
    let polls = 0;
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: {
          status: 200,
          body: { copy: testCopy({ containerStatus: 'starting' }) },
        },
        [`GET ${P}/copy`]: (): StubReply => {
          polls += 1;
          return {
            status: 200,
            body: { copy: polls < 2 ? testCopy({ containerStatus: 'starting' }) : running },
          };
        },
        [LAUNCH]: freshTickets(),
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByText('Starting your IDE…')).toBeInTheDocument();
    expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
    expect(calls(fetchMock, LAUNCH)).toBe(0);
    expect(await screen.findByTitle('VS Code for Website', {}, { timeout: 4000 })).toHaveAttribute(
      'src',
      launchUrl('t1'),
    );
    expect(calls(fetchMock, `GET ${P}/copy`)).toBe(2);
  });

  it('shows a loading state while the launch URL is on its way', async () => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: 'pending',
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByText('Opening your IDE…')).toBeInTheDocument();
    expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
  });

  it('shows a clear error when the container failed, and tries again on request', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: (): StubReply => {
          attempt += 1;
          return {
            status: 200,
            body: { copy: attempt === 1 ? testCopy({ containerStatus: 'failed' }) : running },
          };
        },
        [LAUNCH]: freshTickets(),
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByRole('alert')).toHaveTextContent('Your IDE couldn’t start.');
    expect(calls(fetchMock, LAUNCH)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t1'));
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(2);
  });

  it('retries a failed launch with a fresh ticket', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: (): StubReply => {
          attempt += 1;
          return attempt === 1
            ? { status: 500, body: { error: 'internal', message: 'Something broke' } }
            : { status: 200, body: { url: launchUrl('t2') } };
        },
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not open your IDE. Something broke',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t2'));
    expect(calls(fetchMock, LAUNCH)).toBe(2);
  });

  it('starts the container again when it stopped before the launch (409 ide_not_running)', async () => {
    const user = userEvent.setup();
    let launches = 0;
    const fetchMock = stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: (): StubReply => {
          launches += 1;
          return launches === 1
            ? { status: 409, body: { error: 'ide_not_running', message: 'The IDE is not running' } }
            : { status: 200, body: { url: launchUrl('t2') } };
        },
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your IDE stopped before it could open.',
    );
    await user.click(screen.getByRole('button', { name: 'Start the IDE' }));
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute('src', launchUrl('t2'));
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(2);
  });

  it.each(['/ide/abc/', 'javascript:alert(1)', 'ftp://127.0.0.1/x'])(
    'never frames a launch URL that is not absolute http(s): %s',
    async (url) => {
      stubApi(
        ideRoutes({
          [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
          [LAUNCH]: { status: 200, body: { url } },
        }),
      );
      renderApp('/projects/project-1/ide');
      expect(await screen.findByRole('alert')).toHaveTextContent('unexpected response');
      expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      'another copy’s address',
      'http://0b9d2c1e-1111-4222-8333-944445555666.ide.localhost:3100/ide-launch?ticket=x',
    ],
    ['the bare IDE base host', 'http://ide.localhost:3100/ide-launch?ticket=x'],
    ['the old shared address', 'http://127.0.0.1:3100/ide-launch?ticket=x'],
    ['the app’s own origin', `${window.location.origin}/ide-launch?ticket=x`],
  ])('never frames a launch URL on %s', async (_what, url) => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: { status: 200, body: { url } },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the server sent an address that isn’t this copy’s IDE address',
    );
    expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
    // No Preview from an address the IDE didn't open on.
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('frames this copy’s own address on any IDE base host, http or https', async () => {
    const url = `https://${running.id.toUpperCase()}.devspace-ide.example/ide-launch?ticket=x`;
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
        [LAUNCH]: { status: 200, body: { url } },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toHaveAttribute(
      'src',
      `https://${running.id}.devspace-ide.example/ide-launch?ticket=x`,
    );
  });

  it('explains that the repository is not ready (409)', async () => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: {
          status: 409,
          body: { error: 'repository_not_ready', message: 'The repository is not ready' },
        },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The project’s repository isn’t ready yet.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says there is no project for a 404', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      [`GET ${P}`]: { status: 404, body: { error: 'not_found', message: 'Project not found' } },
      [`POST ${P}/copy/ide`]: {
        status: 404,
        body: { error: 'not_found', message: 'Project not found' },
      },
    });
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no project you can open at this address.',
    );
  });

  it('shows the server’s message for other errors', async () => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: {
          status: 500,
          body: { error: 'internal', message: 'Docker is not reachable' },
        },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start your IDE. Docker is not reachable',
    );
  });

  it('offers to start a stopped IDE again', async () => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: {
          status: 200,
          body: { copy: testCopy({ containerStatus: 'stopped' }) },
        },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your IDE isn’t running.');
    expect(screen.getByRole('button', { name: 'Start the IDE' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload IDE' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('ide-ai-hint')).not.toBeInTheDocument();
  });
});

describe('IDE page AI assistant hint', () => {
  async function hintFor(
    aiAssistant: AiAssistantStatus,
    project: ProjectDetail = testProject('member'),
  ): Promise<HTMLElement> {
    const copy = testCopy({ containerStatus: 'running', aiAssistant });
    stubApi({
      ...ideRoutes({
        [`POST ${P}/copy/ide`]: { status: 200, body: { copy } },
        [LAUNCH]: freshTickets(),
      }),
      [`GET ${P}`]: { status: 200, body: { project } },
    });
    renderApp('/projects/project-1/ide');
    await screen.findByTitle('VS Code for Website');
    return screen.getByTestId('ide-ai-hint');
  }

  it('tells a ready member how to use the assistant', async () => {
    const hint = await hintFor({ ready: true, reason: null });
    expect(hint).toHaveAttribute('data-ready', 'true');
    expect(hint).toHaveTextContent(
      'AI assistant: Click the AI icon on the left and describe what to build.',
    );
  });

  it.each([
    ['not_connected', 'connect your OpenRouter account'],
    ['notice_required', 'read and accept the AI notice'],
  ] as const)('links to AI settings for %s', async (reason, name) => {
    const hint = await hintFor({ ready: false, reason });
    expect(hint).toHaveAttribute('data-ready', 'false');
    expect(hint).toHaveAttribute('data-reason', reason);
    expect(within(hint).getByRole('link', { name })).toHaveAttribute('href', '/settings/ai');
  });

  it('asks a member to ask a leader when AI is off', async () => {
    const hint = await hintFor({ ready: false, reason: 'ai_disabled' });
    expect(hint).toHaveTextContent('Ask a leader to switch it on in the project’s Settings.');
    expect(within(hint).queryByRole('link')).toBeNull();
  });

  it('links a leader to the project’s Settings when AI is off', async () => {
    const hint = await hintFor({ ready: false, reason: 'ai_disabled' }, testProject('leader'));
    expect(within(hint).getByRole('link', { name: 'Switch it on in Settings' })).toHaveAttribute(
      'href',
      '/projects/project-1/settings',
    );
  });
});
