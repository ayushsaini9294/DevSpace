import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProjectRequestSchema, CreateTeamRequestSchema } from '@devspace/shared';
import {
  emptyDashboard,
  healthOk,
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testProject,
  testTeam,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('home dashboard', () => {
  it('lists your projects (with team and role) and your teams', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/health': healthOk,
      'GET /api/projects': {
        status: 200,
        body: {
          projects: [
            testProject('leader'),
            { ...testProject('member'), id: 'project-2', name: 'Mobile app' },
          ],
        },
      },
      'GET /api/teams': { status: 200, body: { teams: [testTeam] } },
    });
    renderApp('/');

    const projects = await screen.findByRole('region', { name: 'Your projects' });
    const website = await within(projects).findByRole('link', { name: 'Website' });
    expect(website).toHaveAttribute('href', '/projects/project-1');
    expect(within(projects).getByText('Core team · Leader')).toBeInTheDocument();
    expect(within(projects).getByRole('link', { name: 'Mobile app' })).toHaveAttribute(
      'href',
      '/projects/project-2',
    );
    expect(within(projects).getByText('Core team · Member')).toBeInTheDocument();

    const teams = screen.getByRole('region', { name: 'Your teams' });
    expect(await within(teams).findByRole('link', { name: 'Core team' })).toHaveAttribute(
      'href',
      '/teams/team-1',
    );
    expect(screen.getByText('Welcome, Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('api-status')).toBeInTheDocument();
  });

  it('shows empty states', async () => {
    stubApi({ 'GET /api/auth/me': loggedIn, 'GET /api/health': healthOk, ...emptyDashboard });
    renderApp('/');
    expect(await screen.findByText(/You aren’t in any projects yet/)).toBeInTheDocument();
    expect(await screen.findByText(/You aren’t in any teams yet/)).toBeInTheDocument();
  });

  it('shows a load error instead of a blank list', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/health': healthOk,
      'GET /api/projects': { status: 500, body: { error: 'internal', message: 'Server broke' } },
      'GET /api/teams': { status: 200, body: { teams: [] } },
    });
    renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your projects. Server broke',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('validates the team name, then creates the team and opens it', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/health': healthOk,
      ...emptyDashboard,
      'POST /api/teams': { status: 201, body: { team: testTeam } },
      'GET /api/teams/team-1': { status: 200, body: { team: testTeam, projects: [] } },
    });
    const { router } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Create team' }));
    const input = screen.getByLabelText('Team name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a name');
    expect(input).toHaveFocus();

    await user.type(input, '  Core team ');
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Core team' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/teams/team-1');
    expect(CreateTeamRequestSchema.parse(requestBody(fetchMock, 'POST /api/teams'))).toEqual({
      name: 'Core team',
    });
  });
});

describe('team page', () => {
  it('lists your projects in the team and creates a project', async () => {
    const user = userEvent.setup();
    const created = { ...testProject('leader'), id: 'project-9', name: 'API' };
    const fetchMock = stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/teams/team-1': {
        status: 200,
        body: { team: testTeam, projects: [testProject('member')] },
      },
      'POST /api/teams/team-1/projects': { status: 201, body: { project: created } },
      'GET /api/projects/project-9': { status: 200, body: { project: created } },
      'GET /api/projects': { status: 200, body: { projects: [] } },
      'GET /api/teams': { status: 200, body: { teams: [testTeam] } },
    });
    const { router } = renderApp('/teams/team-1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Core team' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );

    await user.type(screen.getByLabelText('Project name'), 'API');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'API' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects/project-9');
    expect(
      CreateProjectRequestSchema.parse(requestBody(fetchMock, 'POST /api/teams/team-1/projects')),
    ).toEqual({ name: 'API' });
  });

  it('shows Team not found for a 404', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/teams/nope': { status: 404, body: { error: 'not_found', message: 'Not found' } },
    });
    renderApp('/teams/nope');
    expect(await screen.findByRole('heading', { name: 'Team not found' })).toBeInTheDocument();
  });
});
