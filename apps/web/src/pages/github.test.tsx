import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GithubConnectFinishRequestSchema,
  PublishGithubRequestSchema,
  SetUpRepositoryRequestSchema,
  UpdateProjectSettingsRequestSchema,
  type ActivityEntry,
  type NotificationView,
  type ProjectDetail,
} from '@devspace/shared';
import { browser } from '../lib/ai';
import { githubKeys } from '../lib/github';
import { describeActivity } from '../lib/labels';
import { targetsFor } from '../lib/live';
import { describeNotification, notificationUrl } from '../lib/notifications';
import {
  GITHUB_INSTALL_URL,
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testGithubAccount,
  testGithubLink,
  testProject,
  testProjectGithub,
  testRepository,
  type StubRoutes,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';

function calls(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  ).length;
}

function projectRoutes(project: ProjectDetail, extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    ...extra,
  };
}

function githubSection() {
  return screen.findByTestId('github-section');
}

// ---------- Settings → GitHub ----------

describe('GitHub settings page', () => {
  it('is linked from my user menu', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/github/account': { status: 200, body: testGithubAccount() },
    });
    const { router } = renderApp('/settings/github');
    await user.click(await screen.findByTestId('current-user'));
    const link = screen.getByRole('link', { name: 'GitHub settings' });
    expect(link).toHaveAttribute('href', '/settings/github');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/settings/github');
  });

  it('says plainly when GitHub isn’t set up on this DevSpace', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/github/account': {
        status: 200,
        body: testGithubAccount({
          configured: false,
          connected: false,
          login: null,
          connectedAt: null,
          installUrl: null,
          appInstalled: null,
        }),
      },
    });
    renderApp('/settings/github');
    expect(await screen.findByTestId('github-not-configured')).toHaveTextContent(
      'GitHub isn’t set up on this DevSpace yet.',
    );
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  it('connects by leaving for GitHub in the same tab', async () => {
    const user = userEvent.setup();
    const leave = vi.spyOn(browser, 'leaveFor').mockImplementation(() => {});
    const authorize = 'https://github.com/login/oauth/authorize?client_id=x&state=s';
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/github/account': {
        status: 200,
        body: testGithubAccount({ connected: false, login: null, appInstalled: null }),
      },
      'POST /api/github/connect/start': { status: 200, body: { url: authorize } },
    });
    renderApp('/settings/github');

    expect(await screen.findByTestId('github-connection-status')).toHaveTextContent(
      'Not connected',
    );
    await user.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith(authorize));
    expect(calls(fetchMock, 'POST /api/github/connect/start')).toBe(1);
  });

  it('shows my login and the install link, and disconnects', async () => {
    const user = userEvent.setup();
    let account = testGithubAccount();
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/github/account': () => ({ status: 200, body: account }),
      'DELETE /api/github/account': () => {
        account = testGithubAccount({ connected: false, login: null, appInstalled: null });
        return { status: 204 };
      },
    });
    renderApp('/settings/github');

    expect(await screen.findByTestId('github-connection-status')).toHaveTextContent('Connected');
    expect(screen.getByTestId('github-login')).toHaveTextContent('ada');
    const install = screen.getByRole('link', { name: 'Install the DevSpace app on GitHub' });
    expect(install).toHaveAttribute('href', GITHUB_INSTALL_URL);
    expect(install).toHaveAttribute('data-testid', 'github-install-link');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByText('Disconnected. DevSpace no longer has your GitHub sign-in.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('github-connection-status')).toHaveTextContent('Not connected');
    expect(calls(fetchMock, 'DELETE /api/github/account')).toBe(1);
  });

  it('finishes connecting on the callback page, once', async () => {
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'POST /api/github/connect/finish': { status: 200, body: testGithubAccount() },
    });
    const { router } = renderApp('/settings/github/callback?code=the-code&state=the-state');

    expect(await screen.findByText('GitHub connected.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/github');
    expect(
      GithubConnectFinishRequestSchema.parse(
        requestBody(fetchMock, 'POST /api/github/connect/finish'),
      ),
    ).toEqual({ code: 'the-code', state: 'the-state' });
    expect(calls(fetchMock, 'POST /api/github/connect/finish')).toBe(1);
  });

  it('explains an expired connection link', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'POST /api/github/connect/finish': {
        status: 400,
        body: { error: 'invalid_state', message: 'Unknown state' },
      },
    });
    renderApp('/settings/github/callback?code=c&state=s');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This connection link has expired or was already used.',
    );
    expect(screen.getByRole('link', { name: 'Back to GitHub settings' })).toBeInTheDocument();
  });

  it('says so when GitHub sent no code', async () => {
    stubApi({ 'GET /api/auth/me': loggedIn });
    renderApp('/settings/github/callback?error=access_denied');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub didn’t send DevSpace a code',
    );
  });
});

// ---------- Project Settings → GitHub ----------

describe('project settings: publish to GitHub', () => {
  it('publishes privately by default, after the email warning is ticked', async () => {
    const user = userEvent.setup();
    const project = testProject('leader', { name: 'My Website!' });
    let view = testProjectGithub({ emailWarning: { names: ['Grace Hopper'] } });
    const fetchMock = stubApi(
      projectRoutes(project, {
        [`GET ${P}/github`]: () => ({ status: 200, body: view }),
        [`POST ${P}/github/publish`]: () => {
          view = testProjectGithub({
            canPublish: false,
            link: testGithubLink({
              repoFullName: 'ada/My-Website',
              htmlUrl: 'https://github.com/ada/My-Website',
              status: 'pushing',
              lastPushedAt: null,
              lastPushedSha: null,
            }),
          });
          return { status: 202, body: view };
        },
      }),
    );
    renderApp('/projects/project-1/settings');

    const section = await githubSection();
    const name = await within(section).findByLabelText('Repository name');
    expect(name).toHaveValue('My-Website');
    expect(within(section).getByLabelText('Make it public')).not.toBeChecked();
    expect(within(section).getByLabelText('Publish once')).toBeChecked();
    const warning = within(section).getByTestId('github-email-warning');
    expect(warning).toHaveTextContent('Grace Hopper');
    expect(warning).not.toHaveTextContent('@');

    // The tick is required.
    await user.click(within(section).getByRole('button', { name: 'Publish to GitHub' }));
    expect(await within(section).findByText('Tick this box to go ahead.')).toBeInTheDocument();
    expect(calls(fetchMock, `POST ${P}/github/publish`)).toBe(0);

    await user.click(
      within(section).getByLabelText('I understand these addresses will be public on GitHub'),
    );
    await user.click(within(section).getByLabelText('Keep updated'));
    await user.click(within(section).getByRole('button', { name: 'Publish to GitHub' }));

    const status = await within(section).findByTestId('github-status');
    expect(status).toHaveAttribute('data-status', 'pushing');
    expect(status).toHaveTextContent('Sending to GitHub…');
    expect(within(section).getByTestId('github-repo-link')).toHaveAttribute(
      'href',
      'https://github.com/ada/My-Website',
    );
    expect(
      PublishGithubRequestSchema.parse(requestBody(fetchMock, `POST ${P}/github/publish`)),
    ).toEqual({
      name: 'My-Website',
      private: true,
      mode: 'keep_updated',
      acceptEmailWarning: true,
    });
  });

  it('checks the repository name before sending', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: testProjectGithub() },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    const name = await within(section).findByLabelText('Repository name');
    await user.clear(name);
    await user.type(name, 'my site');
    await user.click(within(section).getByRole('button', { name: 'Publish to GitHub' }));
    expect(
      await within(section).findByText('Use only letters, numbers, dots, dashes and underscores'),
    ).toBeInTheDocument();
    expect(name).toHaveFocus();
    expect(calls(fetchMock, `POST ${P}/github/publish`)).toBe(0);
  });

  it('sends a public repository only when “Make it public” is ticked', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: testProjectGithub() },
        [`POST ${P}/github/publish`]: 'pending',
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await user.click(await within(section).findByLabelText('Make it public'));
    expect(within(section).getByText(/Anyone on the internet/)).toBeInTheDocument();
    expect(within(section).queryByTestId('github-email-warning')).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Publish to GitHub' }));
    await waitFor(() => expect(calls(fetchMock, `POST ${P}/github/publish`)).toBe(1));
    expect(requestBody(fetchMock, `POST ${P}/github/publish`)).toEqual({
      name: 'Website',
      private: false,
      mode: 'publish_once',
      acceptEmailWarning: false,
    });
  });

  it('shows a taken name on the name field', async () => {
    const user = userEvent.setup();
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: testProjectGithub() },
        [`POST ${P}/github/publish`]: {
          status: 409,
          body: { error: 'repo_exists', message: 'Taken' },
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await user.click(await within(section).findByRole('button', { name: 'Publish to GitHub' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'You already have a repository with this name on GitHub. Pick another name.',
    );
    expect(within(section).getByLabelText('Repository name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('links to the app install page when the app isn’t installed', async () => {
    const user = userEvent.setup();
    const install = 'https://github.com/apps/devspace/installations/new?x=1';
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: testProjectGithub() },
        [`POST ${P}/github/publish`]: {
          status: 409,
          body: {
            error: 'app_not_installed',
            message: 'Install the app',
            details: { installUrl: install },
          },
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await user.click(await within(section).findByRole('button', { name: 'Publish to GitHub' }));
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent('The DevSpace app isn’t installed on your GitHub account yet.');
    expect(
      within(alert).getByRole('link', { name: 'Install the DevSpace app on GitHub' }),
    ).toHaveAttribute('href', install);
  });

  it('asks me to connect GitHub first', async () => {
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: testProjectGithub({ connected: false }) },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    const note = await within(section).findByTestId('github-connect-first');
    expect(within(note).getByRole('link', { name: 'GitHub settings' })).toHaveAttribute(
      'href',
      '/settings/github',
    );
    expect(within(section).queryByRole('button', { name: 'Publish to GitHub' })).toBeNull();
  });

  it('says when GitHub isn’t set up on this DevSpace', async () => {
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: {
          status: 200,
          body: testProjectGithub({ configured: false, connected: false, installUrl: null }),
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    expect(await screen.findByTestId('github-not-configured')).toHaveTextContent(
      'GitHub isn’t set up on this DevSpace yet.',
    );
  });

  it('shows a member allowed to publish only the GitHub section', async () => {
    stubApi(
      projectRoutes(
        testProject('member', {
          myPermissions: {
            approve: false,
            comment: false,
            createTasks: false,
            aiReview: false,
            publishGithub: true,
          },
        }),
        { [`GET ${P}/github`]: { status: 200, body: testProjectGithub({ canUnlink: false }) } },
      ),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    expect(
      await within(section).findByRole('button', { name: 'Publish to GitHub' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Project' })).toHaveTextContent('Settings');
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
  });

  it('tells a member who can’t publish that this isn’t on GitHub yet', async () => {
    // Opened through the address bar: members without the permission get the leaders note.
    stubApi(projectRoutes(testProject('member')));
    renderApp('/projects/project-1/settings');
    expect(
      await screen.findByText('Only the project’s leaders can change its settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('github-section')).not.toBeInTheDocument();
  });
});

describe('project settings: a published project', () => {
  function published(link = testGithubLink(), overrides = {}) {
    return testProjectGithub({ canPublish: false, link, ...overrides });
  }

  it('shows the link, privacy and “Up to date”', async () => {
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: { status: 200, body: published() },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    const link = await within(section).findByTestId('github-repo-link');
    expect(link).toHaveAttribute('href', 'https://github.com/ada/website');
    expect(link).toHaveTextContent('ada/website');
    expect(section).toHaveTextContent('(private)');
    const status = within(section).getByTestId('github-status');
    expect(status).toHaveAttribute('data-status', 'ok');
    expect(status).toHaveTextContent('Up to date');
    expect(within(section).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(section).getByLabelText('Publish once')).toBeChecked();
  });

  it('explains a pause and tries again', async () => {
    const user = userEvent.setup();
    let view = published(
      testGithubLink({
        mode: 'keep_updated',
        status: 'paused',
        statusReason: 'GitHub has changes made outside DevSpace',
      }),
    );
    const fetchMock = stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: () => ({ status: 200, body: view }),
        [`POST ${P}/github/sync`]: () => {
          view = published(testGithubLink({ mode: 'keep_updated', status: 'pushing' }));
          return { status: 202, body: view };
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    const status = await within(section).findByTestId('github-status');
    expect(status).toHaveAttribute('data-status', 'paused');
    expect(status).toHaveTextContent('Paused');
    expect(within(section).getByTestId('github-status-reason')).toHaveTextContent(
      'GitHub has changes made outside DevSpace',
    );
    expect(section).toHaveTextContent('never overwrites changes made directly on GitHub');

    await user.click(within(section).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(within(section).getByTestId('github-status')).toHaveAttribute(
        'data-status',
        'pushing',
      ),
    );
    expect(calls(fetchMock, `POST ${P}/github/sync`)).toBe(1);
  });

  it('shows a failure with its reason, and Try again errors in plain words', async () => {
    const user = userEvent.setup();
    stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: {
          status: 200,
          body: published(testGithubLink({ status: 'failed', statusReason: 'GitHub was down' })),
        },
        [`POST ${P}/github/sync`]: {
          status: 409,
          body: { error: 'sync_running', message: 'Running' },
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    expect(await within(section).findByTestId('github-status')).toHaveTextContent('Failed');
    expect(within(section).getByTestId('github-status-reason')).toHaveTextContent(
      'GitHub was down',
    );
    await user.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'DevSpace is already sending main to GitHub.',
    );
  });

  it('hides Try again and Unlink from people who may not use them', async () => {
    stubApi(
      projectRoutes(
        testProject('member', {
          myPermissions: {
            approve: false,
            comment: false,
            createTasks: false,
            aiReview: false,
            publishGithub: true,
          },
        }),
        {
          [`GET ${P}/github`]: {
            status: 200,
            body: published(testGithubLink({ status: 'paused', statusReason: 'Changed' }), {
              canManage: false,
              canUnlink: false,
            }),
          },
        },
      ),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await within(section).findByTestId('github-status');
    expect(within(section).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Unlink' })).toBeNull();
    // Members can't change the mode; they see it.
    expect(section).toHaveTextContent('Mode: Publish once');
  });

  it('changes the mode through the project’s settings', async () => {
    const user = userEvent.setup();
    const project = testProject('leader');
    const fetchMock = stubApi(
      projectRoutes(project, {
        [`GET ${P}/github`]: { status: 200, body: published() },
        [`PATCH ${P}/settings`]: {
          status: 200,
          body: {
            project: { ...project, settings: { ...project.settings, githubMode: 'keep_updated' } },
          },
        },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await user.click(await within(section).findByLabelText('Keep updated'));
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fetchMock, `PATCH ${P}/settings`)).toBe(1));
    expect(
      UpdateProjectSettingsRequestSchema.parse(requestBody(fetchMock, `PATCH ${P}/settings`)),
    ).toEqual({ githubMode: 'keep_updated' });
  });

  it('unlinks after a confirmation', async () => {
    const user = userEvent.setup();
    let view = published();
    const fetchMock = stubApi(
      projectRoutes(testProject('leader'), {
        [`GET ${P}/github`]: () => ({ status: 200, body: view }),
        [`DELETE ${P}/github`]: () => {
          view = testProjectGithub();
          return { status: 204 };
        },
        [`GET ${P}/activity`]: { status: 200, body: { entries: [] } },
      }),
    );
    renderApp('/projects/project-1/settings');
    const section = await githubSection();
    await user.click(await within(section).findByRole('button', { name: 'Unlink' }));
    expect(section).toHaveTextContent('The repository stays on GitHub.');
    await user.click(within(section).getByRole('button', { name: 'Yes, unlink' }));
    expect(
      await within(section).findByRole('button', { name: 'Publish to GitHub' }),
    ).toBeInTheDocument();
    expect(calls(fetchMock, `DELETE ${P}/github`)).toBe(1);
  });
});

// ---------- Repository setup: Import from GitHub ----------

describe('repository setup: import from GitHub', () => {
  function setupRoutes(extra: StubRoutes = {}): StubRoutes {
    return projectRoutes(testProject('leader'), {
      [`GET ${P}/repository`]: { status: 200, body: { repository: testRepository() } },
      'GET /api/github/account': { status: 200, body: testGithubAccount() },
      ...extra,
    });
  }

  it('imports a picked repository, with private ones marked', async () => {
    const user = userEvent.setup();
    const importing = testRepository({
      status: 'importing',
      source: 'github',
      importUrl: 'https://github.com/ada/secret',
    });
    const fetchMock = stubApi(
      setupRoutes({
        'GET /api/github/repos': {
          status: 200,
          body: {
            repos: [
              {
                fullName: 'ada/public-site',
                private: false,
                defaultBranch: 'main',
                htmlUrl: 'https://github.com/ada/public-site',
                sizeKb: 12,
              },
              {
                fullName: 'ada/secret',
                private: true,
                defaultBranch: 'trunk',
                htmlUrl: 'https://github.com/ada/secret',
                sizeKb: 40,
              },
            ],
            installUrl: GITHUB_INSTALL_URL,
          },
        },
        [`POST ${P}/repository`]: { status: 202, body: { repository: importing } },
        [`GET ${P}/activity`]: { status: 200, body: { entries: [] } },
      }),
    );
    renderApp('/projects/project-1/files');

    await user.click(await screen.findByRole('radio', { name: 'Import from GitHub' }));
    const picker = await screen.findByLabelText('GitHub repository');
    expect(
      within(picker).getByRole('option', { name: 'ada/secret (private)' }),
    ).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'ada/public-site' })).toBeInTheDocument();

    // Nothing picked yet.
    await user.click(screen.getByRole('button', { name: 'Import from GitHub' }));
    expect(await screen.findByText('Choose a repository from the list.')).toBeInTheDocument();
    expect(calls(fetchMock, `POST ${P}/repository`)).toBe(0);

    await user.selectOptions(picker, 'ada/secret');
    await user.click(screen.getByRole('button', { name: 'Import from GitHub' }));
    expect(
      await screen.findByText('Importing from https://github.com/ada/secret…'),
    ).toBeInTheDocument();
    expect(
      SetUpRepositoryRequestSchema.parse(requestBody(fetchMock, `POST ${P}/repository`)),
    ).toEqual({ source: 'github', repoFullName: 'ada/secret' });
  });

  it('points to the app install page when no repository is reachable', async () => {
    stubApi(
      setupRoutes({
        'GET /api/github/repos': {
          status: 200,
          body: { repos: [], installUrl: GITHUB_INSTALL_URL },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/projects/project-1/files');
    await user.click(await screen.findByRole('radio', { name: 'Import from GitHub' }));
    const empty = await screen.findByTestId('github-no-repos');
    expect(
      within(empty).getByRole('link', { name: 'Install the DevSpace app on GitHub' }),
    ).toHaveAttribute('href', GITHUB_INSTALL_URL);
    expect(within(empty).getByRole('button', { name: 'Refresh the list' })).toBeInTheDocument();
  });

  it('asks me to connect GitHub first', async () => {
    const user = userEvent.setup();
    stubApi(
      setupRoutes({
        'GET /api/github/account': {
          status: 200,
          body: testGithubAccount({ connected: false, login: null, appInstalled: null }),
        },
      }),
    );
    renderApp('/projects/project-1/files');
    await user.click(await screen.findByRole('radio', { name: 'Import from GitHub' }));
    const box = await screen.findByTestId('github-import');
    expect(within(box).getByRole('link', { name: 'GitHub settings' })).toHaveAttribute(
      'href',
      '/settings/github',
    );
  });

  it('shows clear words when the repository can’t be reached', async () => {
    const user = userEvent.setup();
    stubApi(
      setupRoutes({
        'GET /api/github/repos': {
          status: 200,
          body: {
            repos: [
              {
                fullName: 'ada/gone',
                private: true,
                defaultBranch: 'main',
                htmlUrl: 'https://github.com/ada/gone',
                sizeKb: 1,
              },
            ],
            installUrl: GITHUB_INSTALL_URL,
          },
        },
        [`POST ${P}/repository`]: {
          status: 404,
          body: { error: 'github_repo_not_found', message: 'Not found' },
        },
      }),
    );
    renderApp('/projects/project-1/files');
    await user.click(await screen.findByRole('radio', { name: 'Import from GitHub' }));
    await user.selectOptions(await screen.findByLabelText('GitHub repository'), 'ada/gone');
    await user.click(screen.getByRole('button', { name: 'Import from GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'DevSpace can’t reach this GitHub repository.',
    );
  });

  it('doesn’t offer GitHub when it isn’t set up on this DevSpace', async () => {
    stubApi(
      setupRoutes({
        'GET /api/github/account': {
          status: 200,
          body: testGithubAccount({
            configured: false,
            connected: false,
            login: null,
            connectedAt: null,
            installUrl: null,
            appInstalled: null,
          }),
        },
      }),
    );
    renderApp('/projects/project-1/files');
    expect(await screen.findByRole('radio', { name: 'Start empty' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: 'Import from GitHub' })).toBeNull(),
    );
  });
});

// ---------- Live updates, notifications and activity ----------

describe('GitHub live updates and wording', () => {
  it('refreshes the project’s GitHub status on the `github` key', () => {
    expect(targetsFor('project-1', 'github', 'user-1')).toEqual([
      { queryKey: githubKeys.project('project-1') },
    ]);
    expect(targetsFor('project-1', 'members', 'user-1')).toContainEqual({
      queryKey: githubKeys.project('project-1'),
    });
  });

  it('describes the pause and failure notifications and links to Settings', () => {
    const base = {
      id: 'n-1',
      project: { id: 'project-1', name: 'Website' },
      readAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    const paused: NotificationView = {
      ...base,
      type: 'github.sync_paused',
      data: { repoFullName: 'ada/website', reason: 'GitHub has changes made outside DevSpace' },
    };
    const failed: NotificationView = {
      ...base,
      type: 'github.sync_failed',
      data: { repoFullName: 'ada/website', reason: 'GitHub was down' },
    };
    expect(describeNotification(paused)).toBe(
      'Sending main to GitHub (ada/website) is paused: GitHub has changes made outside DevSpace',
    );
    expect(describeNotification(failed)).toBe(
      'Sending main to GitHub (ada/website) failed: GitHub was down',
    );
    expect(notificationUrl(paused)).toBe('/projects/project-1/settings#github');
  });

  it('describes GitHub activity', () => {
    const entry = (
      action: string,
      data: Record<string, unknown>,
      actorName: string | null,
    ): ActivityEntry => ({
      id: 'a-1',
      action,
      actorId: actorName ? 'user-1' : null,
      actorName,
      target: null,
      data,
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    expect(
      describeActivity(
        entry('github.published', { repoFullName: 'ada/site', private: true }, 'Ada'),
      ),
    ).toBe('Ada published the project to GitHub (ada/site)');
    expect(
      describeActivity(
        entry('github.published', { repoFullName: 'ada/site', private: false }, 'Ada'),
      ),
    ).toBe('Ada published the project to GitHub (ada/site) as a public repository');
    expect(describeActivity(entry('github.unlinked', { repoFullName: 'ada/site' }, 'Ada'))).toBe(
      'Ada stopped sending the project to GitHub (ada/site)',
    );
    expect(
      describeActivity(entry('github.sync_paused', { reason: 'Changed on GitHub' }, null)),
    ).toBe('Sending main to GitHub was paused: Changed on GitHub');
  });
});
