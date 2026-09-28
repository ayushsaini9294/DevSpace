import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateInvitationRequestSchema,
  DeleteProjectRequestSchema,
  UpdateMemberRequestSchema,
  UpdateProjectSettingsRequestSchema,
  type ProjectDetail,
  type ProjectMember,
} from '@devspace/shared';
import {
  emptyDashboard,
  healthOk,
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testMember,
  testProject,
  testRepository,
  testUser,
  type StubRoutes,
} from '../../test/utils';

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';

function projectRoutes(project: ProjectDetail, extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    [`GET ${P}/repository`]: { status: 200, body: { repository: testRepository() } },
    ...extra,
  };
}

function nav() {
  return screen.getByRole('navigation', { name: 'Project' });
}

describe('project layout and overview', () => {
  it('shows the leader everything, including Settings', async () => {
    stubApi(projectRoutes(testProject('leader')));
    renderApp('/projects/project-1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Website' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Core team' })).toHaveAttribute(
      'href',
      '/teams/team-1',
    );
    for (const name of ['Overview', 'Files', 'Members', 'Activity', 'Settings']) {
      expect(within(nav()).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Your role: Leader')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Set up the repository' })).toHaveAttribute(
      'href',
      '/projects/project-1/files',
    );
  });

  it('hides Settings from members and lists their switched-on permissions', async () => {
    stubApi(
      projectRoutes(
        testProject('member', {
          myPermissions: {
            approve: false,
            comment: true,
            createTasks: false,
            aiReview: false,
            publishGithub: true,
          },
        }),
      ),
    );
    renderApp('/projects/project-1');

    expect(await screen.findByText('Your role: Member')).toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByText('Comment')).toBeInTheDocument();
    expect(screen.getByText('Publish to GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Approve submissions')).not.toBeInTheDocument();
  });

  it('shows Co-leader for co-leaders, with Settings', async () => {
    stubApi(projectRoutes(testProject('co_leader')));
    renderApp('/projects/project-1');
    expect(await screen.findByText('Your role: Co-leader')).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows Project not found for a 404', async () => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      'GET /api/projects/secret': {
        status: 404,
        body: { error: 'not_found', message: 'Project not found' },
      },
    });
    renderApp('/projects/secret/members');
    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project' })).not.toBeInTheDocument();
  });
});

// ---------- Members ----------

const me = (role: ProjectMember['role']) => ({ ...testMember(testUser.id, testUser.name, role) });

function rowFor(name: string): HTMLElement {
  const row = within(screen.getByRole('main')).getByText(name).closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function membersRoutes(project: ProjectDetail, members: ProjectMember[], extra: StubRoutes = {}) {
  return projectRoutes(project, {
    [`GET ${P}/members`]: { status: 200, body: { members } },
    [`GET ${P}/invitations`]: { status: 200, body: { invitations: [] } },
    ...extra,
  });
}

describe('members page', () => {
  it('gives the leader every control that the shared rules allow', async () => {
    const members = [
      me('leader'),
      testMember('user-2', 'Bob Colead', 'co_leader'),
      testMember('user-3', 'Cleo Member', 'member', { comment: true }),
    ];
    stubApi(membersRoutes(testProject('leader'), members));
    renderApp('/projects/project-1/members');

    await screen.findByText('Cleo Member');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeInTheDocument();

    const mine = rowFor('Ada Lovelace');
    expect(within(mine).queryByRole('button')).not.toBeInTheDocument(); // leader can't leave

    const bob = rowFor('Bob Colead');
    expect(within(bob).getByText('bob@example.com')).toBeInTheDocument();
    expect(within(bob).getByText('Co-leader')).toBeInTheDocument();
    expect(within(bob).getByRole('button', { name: 'Make member' })).toBeInTheDocument();
    expect(within(bob).getByRole('button', { name: 'Make leader' })).toBeInTheDocument();
    expect(within(bob).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(bob).queryByRole('checkbox')).not.toBeInTheDocument();

    const cleo = rowFor('Cleo Member');
    expect(within(cleo).getByRole('button', { name: 'Make co-leader' })).toBeInTheDocument();
    expect(within(cleo).getByRole('button', { name: 'Make leader' })).toBeInTheDocument();
    expect(within(cleo).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(cleo).getAllByRole('checkbox')).toHaveLength(5);
    expect(within(cleo).getByLabelText('Comment')).toBeChecked();
    expect(within(cleo).getByLabelText('Approve submissions')).not.toBeChecked();
    for (const label of ['Create tasks', 'AI cross-review', 'Publish to GitHub']) {
      expect(within(cleo).getByLabelText(label)).toBeInTheDocument();
    }
    expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
  });

  it('gives a co-leader only member-level controls and Leave', async () => {
    const members = [
      testMember('user-9', 'Lee Leader', 'leader'),
      me('co_leader'),
      testMember('user-2', 'Bob Colead', 'co_leader'),
      testMember('user-3', 'Cleo Member', 'member'),
    ];
    stubApi(membersRoutes(testProject('co_leader'), members));
    renderApp('/projects/project-1/members');

    await screen.findByText('Cleo Member');
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeInTheDocument();
    expect(within(rowFor('Lee Leader')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowFor('Bob Colead')).queryByRole('button')).not.toBeInTheDocument();

    const cleo = rowFor('Cleo Member');
    expect(within(cleo).getAllByRole('checkbox')).toHaveLength(5);
    expect(within(cleo).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(cleo).queryByRole('button', { name: 'Make co-leader' })).not.toBeInTheDocument();
    expect(within(cleo).queryByRole('button', { name: 'Make leader' })).not.toBeInTheDocument();

    expect(within(rowFor('Ada Lovelace')).getByRole('button', { name: 'Leave project' }));
  });

  it('gives a member no management controls, only Leave', async () => {
    const members = [
      testMember('user-9', 'Lee Leader', 'leader'),
      me('member'),
      testMember('user-3', 'Cleo Member', 'member', { approve: true }),
    ];
    // No invitations stub: a member must not even ask for them.
    stubApi(
      projectRoutes(testProject('member'), {
        [`GET ${P}/members`]: { status: 200, body: { members } },
      }),
    );
    renderApp('/projects/project-1/members');

    await screen.findByText('Cleo Member');
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByText('Pending invitations')).not.toBeInTheDocument();
    expect(within(rowFor('Cleo Member')).getByText('Extra permissions: Approve submissions'));
    // The page's own buttons (the top bar has the bell, my name and Log out).
    const page = within(screen.getByRole('main'));
    expect(page.getAllByRole('button').map((b) => b.textContent)).toEqual(['Leave project']);
  });

  it('switches a permission on with a PATCH of just that key', async () => {
    const user = userEvent.setup();
    const cleo = testMember('user-3', 'Cleo Member', 'member');
    const fetchMock = stubApi(
      membersRoutes(testProject('leader'), [me('leader'), cleo], {
        [`PATCH ${P}/members/user-3`]: {
          status: 200,
          body: { member: { ...cleo, permissions: { ...cleo.permissions, aiReview: true } } },
        },
        [`GET ${P}/activity`]: { status: 200, body: { entries: [] } },
      }),
    );
    renderApp('/projects/project-1/members');

    await user.click(await within(await findRow('Cleo Member')).findByLabelText('AI cross-review'));
    await waitFor(() =>
      expect(
        UpdateMemberRequestSchema.parse(requestBody(fetchMock, `PATCH ${P}/members/user-3`)),
      ).toEqual({ permissions: { aiReview: true } }),
    );
  });

  it('removes a member only after confirming, and shows server errors', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const fetchMock = stubApi(
      membersRoutes(
        testProject('leader'),
        [me('leader'), testMember('user-3', 'Cleo Member', 'member')],
        {
          [`DELETE ${P}/members/user-3`]: {
            status: 403,
            body: { error: 'forbidden', message: 'You can’t remove this member' },
          },
        },
      ),
    );
    renderApp('/projects/project-1/members');
    const remove = within(await findRow('Cleo Member')).getByRole('button', { name: 'Remove' });

    await user.click(remove);
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await user.click(remove);
    expect(await screen.findByRole('alert')).toHaveTextContent('You can’t remove this member');
    expect(requestBody(fetchMock, `DELETE ${P}/members/user-3`)).toEqual({});
  });

  it('creates an invite link and copies it', async () => {
    const user = userEvent.setup();
    const invitation = {
      id: 'inv-1',
      email: 'new@example.com',
      invitedByName: testUser.name,
      expiresAt: '2026-10-04T10:00:00.000Z',
      createdAt: '2026-09-27T10:00:00.000Z',
    };
    let invitations: (typeof invitation)[] = [];
    const fetchMock = stubApi(
      membersRoutes(testProject('leader'), [me('leader')], {
        [`GET ${P}/invitations`]: () => ({ status: 200, body: { invitations } }),
        [`POST ${P}/invitations`]: () => {
          invitations = [invitation];
          return { status: 201, body: { invitation, path: '/invite/tok123' } };
        },
        [`GET ${P}/activity`]: { status: 200, body: { entries: [] } },
      }),
    );
    renderApp('/projects/project-1/members');

    await user.type(await screen.findByLabelText('Email'), ' New@Example.com ');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));

    const link = await screen.findByLabelText('Invite link');
    expect(link).toHaveValue(`${window.location.origin}/invite/tok123`);
    expect(link).toHaveAttribute('readonly');
    expect(
      screen.getByText(/works only for that email address and expires in 7 days/),
    ).toBeInTheDocument();
    expect(
      CreateInvitationRequestSchema.parse(requestBody(fetchMock, `POST ${P}/invitations`)),
    ).toEqual({ email: 'new@example.com' });

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/invite/tok123`);

    // The pending list refreshes and each invitation can be cancelled.
    const pending = await screen.findByRole('region', { name: 'Pending invitations' });
    expect(await within(pending).findByText('new@example.com')).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows a clear message when copying fails', async () => {
    const user = userEvent.setup();
    const invitation = {
      id: 'inv-1',
      email: 'new@example.com',
      invitedByName: testUser.name,
      expiresAt: '2026-10-04T10:00:00.000Z',
      createdAt: '2026-09-27T10:00:00.000Z',
    };
    stubApi(
      membersRoutes(testProject('leader'), [me('leader')], {
        [`POST ${P}/invitations`]: { status: 201, body: { invitation, path: '/invite/tok123' } },
        [`GET ${P}/activity`]: { status: 200, body: { entries: [] } },
      }),
    );
    renderApp('/projects/project-1/members');
    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    await screen.findByLabelText('Invite link');

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t copy automatically');
  });

  it('leaves the project after confirming and goes home', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      membersRoutes(
        testProject('member'),
        [testMember('user-9', 'Lee Leader', 'leader'), me('member')],
        {
          [`DELETE ${P}/members/${testUser.id}`]: { status: 204 },
          'GET /api/health': healthOk,
          ...emptyDashboard,
        },
      ),
    );
    const { router } = renderApp('/projects/project-1/members');

    await user.click(await screen.findByRole('button', { name: 'Leave project' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'DevSpace' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(requestBody(fetchMock, `DELETE ${P}/members/${testUser.id}`)).toEqual({});
  });
});

async function findRow(name: string) {
  await within(screen.getByRole('main')).findByText(name);
  return rowFor(name);
}

// ---------- Settings ----------

describe('settings page', () => {
  it('sends only the settings that changed', async () => {
    const user = userEvent.setup();
    const project = testProject('leader');
    const saved: ProjectDetail = {
      ...project,
      settings: { ...project.settings, membersCanBrowseCopies: true, copyUpdateMode: 'manual' },
    };
    let current = project;
    const fetchMock = stubApi(
      projectRoutes(project, {
        [`GET ${P}`]: () => ({ status: 200, body: { project: current } }),
        [`PATCH ${P}/settings`]: () => {
          current = saved;
          return { status: 200, body: { project: saved } };
        },
      }),
    );
    renderApp('/projects/project-1/settings');

    expect(await screen.findByLabelText('Require approval before merge')).toBeChecked();
    expect(screen.getByLabelText('Automatic')).toBeChecked();
    expect(screen.getByLabelText('Publish once')).toBeChecked();

    // Nothing changed: nothing is sent.
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Nothing changed.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

    await user.click(screen.getByLabelText('Members can browse others’ copies'));
    await user.click(screen.getByLabelText('Manual'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(
      UpdateProjectSettingsRequestSchema.parse(requestBody(fetchMock, `PATCH ${P}/settings`)),
    ).toEqual({ membersCanBrowseCopies: true, copyUpdateMode: 'manual' });
    expect(screen.getByLabelText('Manual')).toBeChecked();
  });

  it('renames the project', async () => {
    const user = userEvent.setup();
    const project = testProject('leader');
    const renamed = { ...project, name: 'New site' };
    let current = project;
    const fetchMock = stubApi(
      projectRoutes(project, {
        [`GET ${P}`]: () => ({ status: 200, body: { project: current } }),
        [`PATCH ${P}`]: () => {
          current = renamed;
          return { status: 200, body: { project: renamed } };
        },
        'GET /api/projects': { status: 200, body: { projects: [] } },
      }),
    );
    renderApp('/projects/project-1/settings');

    const input = await screen.findByLabelText('Project name');
    expect(input).toHaveValue('Website');
    await user.clear(input);
    await user.type(input, 'New site');
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'New site' })).toBeInTheDocument();
    expect(requestBody(fetchMock, `PATCH ${P}`)).toEqual({ name: 'New site' });
  });

  it('deletes only after the exact project name is typed', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      projectRoutes(testProject('leader'), {
        [`DELETE ${P}`]: { status: 204 },
        'GET /api/health': healthOk,
        ...emptyDashboard,
      }),
    );
    const { router } = renderApp('/projects/project-1/settings');

    const button = await screen.findByRole('button', { name: 'Delete project' });
    expect(button).toBeDisabled();
    const confirmInput = screen.getByLabelText('Type the project name to confirm');
    await user.type(confirmInput, 'website');
    expect(button).toBeDisabled();
    await user.clear(confirmInput);
    await user.type(confirmInput, 'Website');
    expect(button).toBeEnabled();
    await user.click(button);

    expect(await screen.findByRole('heading', { level: 1, name: 'DevSpace' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(DeleteProjectRequestSchema.parse(requestBody(fetchMock, `DELETE ${P}`))).toEqual({
      confirmName: 'Website',
    });
  });

  it('shows a co-leader settings but no danger zone', async () => {
    stubApi(projectRoutes(testProject('co_leader')));
    renderApp('/projects/project-1/settings');
    expect(await screen.findByRole('button', { name: 'Save settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });

  it('tells a member that settings are for leaders', async () => {
    stubApi(projectRoutes(testProject('member')));
    renderApp('/projects/project-1/settings');
    expect(
      await screen.findByText('Only the project’s leaders can change its settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });
});

// ---------- Activity ----------

describe('activity page', () => {
  it('lists readable sentences, newest first, falling back to the raw code', async () => {
    const entry = (id: string, action: string, createdAt: string, data = {}) => ({
      id,
      action,
      actorId: testUser.id,
      actorName: testUser.name,
      target: null,
      data,
      createdAt,
    });
    stubApi(
      projectRoutes(testProject('member'), {
        [`GET ${P}/activity`]: {
          status: 200,
          body: {
            entries: [
              entry('a3', 'something.new', '2026-09-27T12:00:00.000Z'),
              entry('a2', 'member.invited', '2026-09-27T11:00:00.000Z', {
                email: 'bo@example.com',
              }),
              entry('a1', 'project.created', '2026-09-27T10:00:00.000Z'),
            ],
          },
        },
      }),
    );
    renderApp('/projects/project-1/activity');

    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Ada Lovelace: something.new');
    expect(items[1]).toHaveTextContent('Ada Lovelace invited bo@example.com');
    expect(items[2]).toHaveTextContent('Ada Lovelace created the project');
  });
});
