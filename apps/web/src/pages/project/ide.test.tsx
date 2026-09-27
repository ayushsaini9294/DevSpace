import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail, RepositoryStatus } from '@devspace/shared';
import {
  loggedIn,
  renderApp,
  stubApi,
  testCopy,
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
const readyRepository = testRepository({ status: 'ready', source: 'empty' });
const running = testCopy({
  containerStatus: 'running',
  ideUrl: `/ide/${testCopy().id}/`,
});

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

describe('Open IDE button', () => {
  it.each(['leader', 'co_leader', 'member'] as const)(
    'is shown to a %s once the repository is ready',
    async (role) => {
      stubApi(overviewRoutes(testProject(role), readyRepository));
      renderApp('/projects/project-1');
      expect(await screen.findByRole('link', { name: 'Open IDE' })).toHaveAttribute(
        'href',
        '/projects/project-1/ide',
      );
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
    });
    const { router } = renderApp('/projects/project-1');
    await user.click(await screen.findByRole('link', { name: 'Open IDE' }));
    expect(router.state.location.pathname).toBe('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toBeInTheDocument();
  });
});

describe('IDE page', () => {
  it('shows VS Code full size at ideUrl when the container is running, with a way back', async () => {
    const fetchMock = stubApi(
      ideRoutes({ [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } } }),
    );
    renderApp('/projects/project-1/ide');

    const frame = await screen.findByTitle('VS Code for Website');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', running.ideUrl);
    expect(screen.getByRole('link', { name: '← Back to the project' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
    // Only one start request, even though the page's effect could run twice.
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(1);
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe('{}');
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
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByText('Starting your IDE…')).toBeInTheDocument();
    expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
    expect(await screen.findByTitle('VS Code for Website', {}, { timeout: 4000 })).toHaveAttribute(
      'src',
      running.ideUrl,
    );
    expect(calls(fetchMock, `GET ${P}/copy`)).toBe(2);
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
      }),
    );
    renderApp('/projects/project-1/ide');

    expect(await screen.findByRole('alert')).toHaveTextContent('Your IDE couldn’t start.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('VS Code for Website')).toBeInTheDocument();
    expect(calls(fetchMock, `POST ${P}/copy/ide`)).toBe(2);
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
  });

  it('never frames an address outside /ide/', async () => {
    stubApi(
      ideRoutes({
        [`POST ${P}/copy/ide`]: {
          status: 200,
          body: { copy: { ...running, ideUrl: 'https://evil.example/' } },
        },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected address');
    expect(screen.queryByTitle(/VS Code/)).not.toBeInTheDocument();
  });
});
