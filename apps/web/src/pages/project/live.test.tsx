import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationView, PresenceView } from '@devspace/shared';
import { targetsFor } from '../../lib/live';
import { LIVE_POLL_MS, useLiveStore, usePollInterval } from '../../lib/liveStore';
import { describeNotification, notificationUrl } from '../../lib/notifications';
import { liveSocket, sockets } from '../../test/fakeSocket';
import {
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testCopy,
  testNotification,
  testPresence,
  testProject,
  testRepository,
  testUser,
  type StubReply,
  type StubRoutes,
} from '../../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';

function projectRoutes(extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project: testProject('member') } },
    [`GET ${P}/repository`]: { status: 200, body: { repository: testRepository() } },
    ...extra,
  };
}

function calls(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
    .length;
}

function presenceReply(members: PresenceView[]): StubReply {
  return { status: 200, body: { members } };
}

function teamPanel() {
  return screen.getByRole('region', { name: 'Team' });
}

function memberRow(name: string) {
  const row = within(teamPanel())
    .getAllByTestId('presence-member')
    .find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`no presence row for ${name}`);
  return row;
}

describe('the live connection', () => {
  it('opens one socket for a logged-in user and joins the open project’s room', async () => {
    stubApi(projectRoutes());
    const { router } = renderApp('/projects/project-1');
    await screen.findByRole('heading', { level: 1, name: 'Website' });

    expect(sockets).toHaveLength(1);
    const socket = liveSocket();
    expect(socket.options).toMatchObject({
      path: '/socket.io',
      transports: ['websocket'],
      withCredentials: true,
    });

    socket.serverConnect();
    expect(socket.sent).toEqual([['project:join', { projectId: 'project-1' }]]);
    expect(useLiveStore.getState().connected).toBe(true);

    stubApi({
      ...projectRoutes(),
      'GET /api/projects': { status: 200, body: { projects: [] } },
      'GET /api/teams': { status: 200, body: { teams: [] } },
      'GET /api/health': { status: 200, body: { status: 'ok', database: 'ok' } },
    });
    await router.navigate('/');
    await waitFor(() =>
      expect(socket.sent.at(-1)).toEqual(['project:leave', { projectId: 'project-1' }]),
    );
  });

  it('opens no socket when logged out', async () => {
    stubApi({
      'GET /api/auth/me': { status: 401, body: { error: 'unauthenticated', message: 'No' } },
      'GET /api/health': { status: 200, body: { status: 'ok', database: 'ok' } },
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Log in' });
    expect(sockets).toHaveLength(0);
  });

  it('joins again after a reconnect and re-reads the project', async () => {
    const fetchMock = stubApi(projectRoutes());
    renderApp('/projects/project-1');
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    const socket = liveSocket();
    socket.serverConnect();
    await waitFor(() => expect(calls(fetchMock, `GET ${P}/presence`)).toBe(1));

    socket.serverDisconnect();
    expect(useLiveStore.getState().connected).toBe(false);
    socket.serverConnect();
    expect(socket.sent.filter(([event]) => event === 'project:join')).toHaveLength(2);
    await waitFor(() => expect(calls(fetchMock, `GET ${P}/presence`)).toBe(2));
    await waitFor(() => expect(calls(fetchMock, 'GET /api/notifications')).toBe(2));
  });

  it('re-reads what an invalidate event names', async () => {
    const fetchMock = stubApi(projectRoutes());
    renderApp('/projects/project-1');
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    const socket = liveSocket();
    socket.serverConnect();
    await waitFor(() => expect(calls(fetchMock, `GET ${P}/presence`)).toBe(1));
    expect(calls(fetchMock, `GET ${P}/repository`)).toBe(1);

    socket.serverEmit('invalidate', { projectId: 'project-1', keys: ['presence', 'repository'] });
    await waitFor(() => expect(calls(fetchMock, `GET ${P}/presence`)).toBe(2));
    await waitFor(() => expect(calls(fetchMock, `GET ${P}/repository`)).toBe(2));

    // Malformed events are ignored.
    socket.serverEmit('invalidate', { projectId: 'project-1', keys: ['<script>'] });
    socket.serverEmit('invalidate', 'nonsense');
    expect(calls(fetchMock, `GET ${P}/presence`)).toBe(2);
  });

  it('maps every invalidate key to the right queries', () => {
    const me = testUser.id;
    const keys = (key: Parameters<typeof targetsFor>[1]) =>
      targetsFor('p', key, me).map((t) => t.queryKey);
    expect(keys('submissions')).toEqual([['projects', 'p', 'submissions', 'list']]);
    expect(keys('submission:s1')).toEqual([['projects', 'p', 'submissions', 'detail', 's1']]);
    expect(keys('tasks')).toEqual([['projects', 'p', 'tasks']]);
    expect(keys('copy')).toEqual([
      ['projects', 'p', 'copy'],
      ['projects', 'p', 'member-copy'],
    ]);
    expect(keys(`copy:${me}`)).toEqual([['projects', 'p', 'copy']]);
    expect(keys('copy:user-7')).toEqual([['projects', 'p', 'member-copy', 'user-7']]);
    expect(keys('activity')).toEqual([['projects', 'p', 'activity']]);
    expect(keys('repository')).toEqual([['projects', 'p', 'repository']]);
    expect(keys('members')).toEqual([
      ['projects', 'p'],
      ['projects', 'p', 'members'],
      ['projects', 'p', 'invitations'],
      ['projects', 'p', 'presence'],
      ['projects', 'p', 'github'],
    ]);
    expect(targetsFor('p', 'members', me)[0]).toMatchObject({ exact: true });
    expect(keys('presence')).toEqual([['projects', 'p', 'presence']]);
    expect(keys('github')).toEqual([['projects', 'p', 'github']]);
  });

  it('polls every 60 s while connected, and at the normal rate otherwise', () => {
    const { result, rerender } = renderHook(() => usePollInterval(10_000));
    expect(result.current).toBe(10_000);
    useLiveStore.setState({ connected: true });
    rerender();
    expect(result.current).toBe(LIVE_POLL_MS);
  });
});

describe('the Team panel', () => {
  it('shows each member’s state, open file, and last seen, as plain text', async () => {
    stubApi(
      projectRoutes({
        [`GET ${P}/presence`]: presenceReply([
          testPresence({
            user: { id: testUser.id, name: testUser.name },
            state: 'online',
            file: null,
          }),
          testPresence({ file: 'src/<b>app</b>.ts' }),
          testPresence({
            user: { id: 'user-9', name: 'Lee Leader' },
            file: 'src/index.ts',
            copyOwner: { id: 'user-3', name: 'Cleo Member' },
          }),
          testPresence({
            user: { id: 'user-4', name: 'Dan Away' },
            state: 'offline',
            file: null,
            lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
        ]),
      }),
    );
    renderApp('/projects/project-1');
    await within(await screen.findByRole('region', { name: 'Team' })).findByText('Grace Hopper');

    const grace = memberRow('Grace Hopper');
    expect(grace).toHaveAttribute('data-state', 'active');
    expect(within(grace).getByTestId('presence-state')).toHaveTextContent('Active');
    // Shown literally, never as markup.
    expect(within(grace).getByTestId('presence-file')).toHaveTextContent(
      'editing src/<b>app</b>.ts',
    );
    expect(grace.querySelector('b')).toBeNull();

    expect(within(memberRow('Lee Leader')).getByTestId('presence-file')).toHaveTextContent(
      'in Cleo Member’s copy: src/index.ts',
    );

    const me = memberRow('Ada Lovelace');
    expect(me).toHaveTextContent('(you)');
    expect(within(me).getByTestId('presence-state')).toHaveTextContent('Online');
    expect(within(me).queryByTestId('presence-file')).not.toBeInTheDocument();

    const dan = memberRow('Dan Away');
    expect(dan).toHaveAttribute('data-state', 'offline');
    expect(within(dan).getByTestId('presence-last-seen')).toHaveTextContent(
      'last seen 5 minutes ago',
    );
  });

  it('shows Active with no file when a member doesn’t share it', async () => {
    stubApi(
      projectRoutes({ [`GET ${P}/presence`]: presenceReply([testPresence({ file: null })]) }),
    );
    renderApp('/projects/project-1');
    await within(await screen.findByRole('region', { name: 'Team' })).findByText('Grace Hopper');
    const grace = memberRow('Grace Hopper');
    expect(within(grace).getByTestId('presence-state')).toHaveTextContent('Active');
    expect(within(grace).queryByTestId('presence-file')).not.toBeInTheDocument();
  });

  it('updates a member in place from a presence event, without reloading', async () => {
    const fetchMock = stubApi(
      projectRoutes({
        [`GET ${P}/presence`]: presenceReply([
          testPresence({ state: 'online', file: null, copyOwner: null }),
        ]),
      }),
    );
    renderApp('/projects/project-1');
    await within(await screen.findByRole('region', { name: 'Team' })).findByText('Grace Hopper');
    const socket = liveSocket();
    socket.serverConnect();

    socket.serverEmit('presence', {
      projectId: 'project-1',
      member: testPresence({ file: 'src/app.txt' }),
    });
    await waitFor(() =>
      expect(within(memberRow('Grace Hopper')).getByTestId('presence-file')).toHaveTextContent(
        'editing src/app.txt',
      ),
    );
    expect(calls(fetchMock, `GET ${P}/presence`)).toBe(1);

    // Someone new appears too.
    socket.serverEmit('presence', {
      projectId: 'project-1',
      member: testPresence({
        user: { id: 'user-5', name: 'Eve New' },
        state: 'online',
        file: null,
      }),
    });
    await waitFor(() => expect(memberRow('Eve New')).toHaveAttribute('data-state', 'online'));
  });

  it('shows the real error when presence can’t load', async () => {
    stubApi(
      projectRoutes({
        [`GET ${P}/presence`]: { status: 500, body: { error: 'internal', message: 'Boom' } },
      }),
    );
    renderApp('/projects/project-1');
    const panel = await screen.findByRole('region', { name: 'Team' });
    expect(await within(panel).findByText(/Couldn’t load who’s here\. Boom/)).toBeInTheDocument();
  });
});

describe('the notification bell', () => {
  function bell() {
    return screen.getByRole('button', { name: 'Notifications' });
  }

  it('shows the unread count, lists notifications with links, and marks all read', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      ...projectRoutes(),
      'GET /api/notifications': {
        status: 200,
        body: {
          notifications: [
            testNotification(),
            testNotification({ id: 'n-2', readAt: '2026-09-28T09:00:00.000Z' }),
          ],
          unreadCount: 1,
          nextCursor: null,
        },
      },
      'POST /api/notifications/read': { status: 200, body: { unreadCount: 0 } },
    });
    renderApp('/projects/project-1');

    expect(await screen.findByTestId('notification-count')).toHaveTextContent('1');
    await user.click(bell());
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Notifications' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-unread', 'true');
    expect(
      within(items[0]!).getByRole('link', {
        name: 'Grace Hopper approved your submission “Add the login page”',
      }),
    ).toHaveAttribute('href', '/projects/project-1/submissions/sub-1');

    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument());
    expect(requestBody(fetchMock, 'POST /api/notifications/read')).toEqual({ all: true });
    expect(items[0]).toHaveAttribute('data-unread', 'false');
  });

  it('adds a pushed notification and its count live, and marks one read when opened', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      ...projectRoutes(),
      [`GET ${P}/submissions/sub-1`]: 'pending',
      'POST /api/notifications/read': { status: 200, body: { unreadCount: 0 } },
    });
    const { router } = renderApp('/projects/project-1');
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    await waitFor(() => expect(calls(fetchMock, 'GET /api/notifications')).toBe(1));
    expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument();

    const socket = liveSocket();
    socket.serverConnect();
    socket.serverEmit('notification', { notification: testNotification(), unreadCount: 1 });
    expect(await screen.findByTestId('notification-count')).toHaveTextContent('1');

    await user.click(bell());
    await user.click(screen.getByRole('link', { name: /approved your submission/ }));
    expect(router.state.location.pathname).toBe('/projects/project-1/submissions/sub-1');
    await waitFor(() => expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument());
    expect(requestBody(fetchMock, 'POST /api/notifications/read')).toEqual({
      ids: ['notification-1'],
    });
  });

  it('says so when there are none', async () => {
    const user = userEvent.setup();
    stubApi(projectRoutes());
    renderApp('/projects/project-1');
    await screen.findByRole('heading', { level: 1, name: 'Website' });
    await user.click(bell());
    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('describes and links every type', () => {
    const base = {
      id: 'n',
      project: { id: 'project-1', name: 'Website' },
      readAt: null,
      createdAt: '2026-09-28T10:00:00.000Z',
    };
    const sub = { submissionId: 'sub-1', title: 'Login' };
    const task = { taskId: 'task-1', title: 'Build it' };
    const cases: [NotificationView, string, string][] = [
      [
        { ...base, type: 'submission.opened', data: { ...sub, actorName: 'Grace' } },
        'Grace submitted “Login” for review',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        {
          ...base,
          type: 'submission.reviewed',
          data: { ...sub, actorName: 'Grace', decision: 'changes_requested' },
        },
        'Grace requested changes on your submission “Login”',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        {
          ...base,
          type: 'submission.commented',
          data: { ...sub, actorName: 'Grace', commentId: 'c', reply: true, suggestion: false },
        },
        'Grace replied to your comment on “Login”',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        { ...base, type: 'submission.merged', data: { ...sub, actorName: null } },
        'Someone merged your submission “Login” into main',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        { ...base, type: 'submission.rejected', data: { ...sub, actorName: 'Lee', reason: 'No' } },
        'Lee rejected your submission “Login”: No',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        {
          ...base,
          type: 'submission.needs_update',
          data: { ...sub, paths: ['a', 'b'], morePaths: 1 },
        },
        'Your submission “Login” needs an update: it now clashes with main in 3 files',
        '/projects/project-1/submissions/sub-1',
      ],
      [
        { ...base, type: 'task.assigned', data: { ...task, actorName: 'Lee' } },
        'Lee assigned you the task “Build it”',
        '/projects/project-1/tasks?task=task-1',
      ],
      [
        { ...base, type: 'task.confirm_done', data: { ...task, submissionId: 'sub-1' } },
        'Work for the task “Build it” was merged. Is the task done?',
        '/projects/project-1/tasks?task=task-1',
      ],
      [
        { ...base, type: 'copy.helped', data: { actorName: 'Lee' } },
        'Lee opened your copy to help you',
        '/projects/project-1',
      ],
      [
        { ...base, type: 'copy.packages_changed', data: { paths: ['package.json'], morePaths: 0 } },
        'Packages changed in main: run npm install in the terminal',
        '/projects/project-1',
      ],
      [
        { ...base, type: 'member.role_changed', data: { actorName: 'Lee', role: 'co_leader' } },
        'Lee changed your role to Co-leader',
        '/projects/project-1/members',
      ],
      [
        { ...base, type: 'invitation.accepted', data: { userId: 'u', userName: 'Eve' } },
        'Eve accepted an invitation and joined',
        '/projects/project-1/members',
      ],
    ];
    for (const [n, text, url] of cases) {
      expect(describeNotification(n)).toBe(text);
      expect(notificationUrl(n)).toBe(url);
    }
    expect(
      notificationUrl({ ...base, project: null, type: 'copy.helped', data: { actorName: null } }),
    ).toBeNull();
  });
});

describe('Share my open file', () => {
  it('turns sharing off from the user menu', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      ...projectRoutes(),
      'PATCH /api/me/preferences': { status: 200, body: { shareOpenFile: false } },
    });
    renderApp('/projects/project-1');

    const menuButton = await screen.findByTestId('current-user');
    expect(menuButton).toHaveTextContent(testUser.name);
    await user.click(menuButton);
    const toggle = await screen.findByRole('switch', { name: 'Share my open file' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(requestBody(fetchMock, 'PATCH /api/me/preferences')).toEqual({ shareOpenFile: false });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it('shows the error when the change fails', async () => {
    const user = userEvent.setup();
    stubApi({
      ...projectRoutes(),
      'PATCH /api/me/preferences': { status: 500, body: { error: 'internal', message: 'Boom' } },
    });
    renderApp('/projects/project-1');
    await user.click(await screen.findByTestId('current-user'));
    const toggle = await screen.findByRole('switch', { name: 'Share my open file' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(await screen.findByText(/Could not change this setting\. Boom/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the npm reminder', () => {
  it('shows on the overview when packages changed, and Dismiss clears it', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      projectRoutes({
        [`GET ${P}/repository`]: {
          status: 200,
          body: { repository: testRepository({ status: 'ready' }) },
        },
        [`GET ${P}/copy`]: { status: 200, body: { copy: testCopy({ packagesChanged: true }) } },
        [`POST ${P}/copy/packages-dismiss`]: {
          status: 200,
          body: { copy: testCopy({ packagesChanged: false }) },
        },
      }),
    );
    renderApp('/projects/project-1');

    const note = await screen.findByText(/Packages changed in main: run/);
    expect(note).toHaveTextContent('Packages changed in main: run npm install in the terminal');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(screen.queryByText(/Packages changed in main/)).not.toBeInTheDocument(),
    );
    expect(calls(fetchMock, `POST ${P}/copy/packages-dismiss`)).toBe(1);
  });
});
