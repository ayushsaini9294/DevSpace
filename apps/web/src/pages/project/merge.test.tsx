import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, CopyView, SubmissionDetail } from '@devspace/shared';
import { describeActivity } from '../../lib/labels';
import {
  loggedIn,
  renderApp,
  stubApi,
  testCopy,
  testMember,
  testProject,
  testRepository,
  testSubmission,
  testUser,
  type StubReply,
  type StubRoutes,
} from '../../test/utils';

// Monaco doesn't run in jsdom; these tests don't look at diffs.
vi.mock('../../components/code/DiffViewer', () => ({
  default: () => <div data-testid="diff-mock" />,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const S = `${P}/submissions/sub-1`;
const REVIEW = '/projects/project-1/submissions/sub-1';
const lead = { id: 'user-9', name: 'Lee Leader' };
const mergedSha = 'c'.repeat(40);

function base(role: 'leader' | 'co_leader' | 'member', extra: StubRoutes): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project: testProject(role) } },
    [`GET ${S}/file?path=${encodeURIComponent('src/app.ts')}`]: {
      status: 200,
      body: {
        path: 'src/app.ts',
        change: 'modified',
        base: { kind: 'text', content: 'a\n' },
        head: { kind: 'text', content: 'b\n' },
      },
    },
    ...extra,
  };
}

/** GET …/submissions/sub-1 answering whatever `state.current` is now. */
function liveDetail(state: { current: SubmissionDetail }): () => StubReply {
  return () => ({ status: 200, body: { submission: state.current } });
}

function conflict(code: string, paths: string[]): StubReply {
  return { status: 409, body: { error: code, message: 'Refused', details: { paths } } };
}

const merged = testSubmission({
  status: 'merged',
  mergedSha,
  mergedBy: lead,
  mergedAt: new Date().toISOString(),
  mergeBlocker: 'not_active',
  viewerActions: ['revert'],
});

describe('Merge on the review page', () => {
  it('lets a lead merge after confirming, then shows who merged it and Undo merge', async () => {
    const user = userEvent.setup();
    const state = {
      current: testSubmission({ status: 'approved', viewerActions: ['merge', 'reject', 'close'] }),
    };
    stubApi(
      base('leader', {
        [`GET ${S}`]: liveDetail(state),
        [`POST ${S}/merge`]: () => {
          state.current = merged;
          return { status: 200, body: { submission: merged } };
        },
      }),
    );
    renderApp(REVIEW);

    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge into main' });
    expect(dialog).toHaveTextContent('credited to Grace Hopper');
    await user.click(within(dialog).getByRole('button', { name: 'Merge into main' }));

    await waitFor(() =>
      expect(screen.getByTestId('submission-status')).toHaveTextContent('Merged'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Merged by Lee Leader into main')).toBeInTheDocument();
    expect(screen.getByText('ccccccc')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo merge' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('closes without merging on Cancel', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      base('leader', {
        [`GET ${S}`]: {
          status: 200,
          body: { submission: testSubmission({ status: 'approved', viewerActions: ['merge'] }) },
        },
      }),
    );
    renderApp(REVIEW);
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/merge'))).toBe(false);
  });

  it('explains to a lead why it can’t be merged yet, and shows no Merge button', async () => {
    stubApi(
      base('leader', {
        [`GET ${S}`]: {
          status: 200,
          body: {
            submission: testSubmission({
              mergeBlocker: 'approval_required',
              viewerActions: ['reject', 'close'],
            }),
          },
        },
      }),
    );
    renderApp(REVIEW);
    expect(await screen.findByText(/this project needs an approval first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('shows no merge blocker to a plain member', async () => {
    stubApi(
      base('member', {
        [`GET ${S}`]: {
          status: 200,
          body: { submission: testSubmission({ mergeBlocker: 'approval_required' }) },
        },
      }),
    );
    renderApp(REVIEW);
    await screen.findByTestId('submission-status');
    expect(screen.queryByText(/Can’t merge yet/)).not.toBeInTheDocument();
  });

  it('explains a merge refused because it now clashes with main', async () => {
    const user = userEvent.setup();
    stubApi(
      base('leader', {
        [`GET ${S}`]: {
          status: 200,
          body: { submission: testSubmission({ status: 'approved', viewerActions: ['merge'] }) },
        },
        [`POST ${S}/merge`]: conflict('merge_conflict', ['src/app.ts']),
      }),
    );
    renderApp(REVIEW);
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    await user.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This submission now clashes with main in: src/app.ts.',
    );
  });

  it.each([
    ['approval_required', 'needs an approval before merging'],
    ['already_in_main', 'Main already has these changes'],
    ['main_changed', 'Main changed while this was running'],
  ])('explains a merge refused with %s', async (code, text) => {
    const user = userEvent.setup();
    stubApi(
      base('leader', {
        [`GET ${S}`]: {
          status: 200,
          body: { submission: testSubmission({ status: 'approved', viewerActions: ['merge'] }) },
        },
        [`POST ${S}/merge`]: { status: 409, body: { error: code, message: 'Refused' } },
      }),
    );
    renderApp(REVIEW);
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    await user.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});

describe('Undo merge', () => {
  it('undoes after confirming and shows the Reverted state', async () => {
    const user = userEvent.setup();
    const reverted = {
      ...merged,
      status: 'reverted' as const,
      revertedSha: 'd'.repeat(40),
      revertedBy: lead,
      revertedAt: new Date().toISOString(),
      viewerActions: [],
    };
    const state = { current: merged };
    stubApi(
      base('leader', {
        [`GET ${S}`]: liveDetail(state),
        [`POST ${S}/revert`]: () => {
          state.current = reverted;
          return { status: 200, body: { submission: reverted } };
        },
      }),
    );
    renderApp(REVIEW);

    await user.click(await screen.findByRole('button', { name: 'Undo merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Undo this merge' });
    await user.click(within(dialog).getByRole('button', { name: 'Undo merge' }));

    await waitFor(() =>
      expect(screen.getByTestId('submission-status')).toHaveTextContent('Reverted'),
    );
    expect(screen.getByText('Merge undone by Lee Leader')).toBeInTheDocument();
    expect(screen.getByText(/back in Grace Hopper’s copy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo merge' })).not.toBeInTheDocument();
  });

  it('lists the files when later merges changed the same lines', async () => {
    const user = userEvent.setup();
    stubApi(
      base('leader', {
        [`GET ${S}`]: { status: 200, body: { submission: merged } },
        [`POST ${S}/revert`]: conflict('revert_conflict', ['src/app.ts', 'README.md']),
      }),
    );
    renderApp(REVIEW);
    await user.click(await screen.findByRole('button', { name: 'Undo merge' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo merge' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Main was not changed');
    const list = within(alert).getByRole('list', { name: 'Files changed again since the merge' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['src/app.ts', 'README.md']);
  });
});

describe('Needs update panel', () => {
  const needsUpdate = (overrides: Partial<SubmissionDetail> = {}) =>
    testSubmission({
      status: 'needs_update',
      conflictPaths: ['src/app.ts'],
      mergeBlocker: 'needs_update',
      ...overrides,
    });

  it('shows the author the clashing files, the steps and Update my copy', async () => {
    stubApi(
      base('member', {
        [`GET ${S}`]: {
          status: 200,
          body: {
            submission: needsUpdate({
              author: { id: testUser.id, name: testUser.name },
              viewerActions: ['update', 'comment', 'close'],
            }),
          },
        },
        [`GET ${P}/copy`]: { status: 200, body: { copy: testCopy({ behind: true }) } },
        [`GET ${P}/copy/update`]: {
          status: 200,
          body: { behind: true, conflictPaths: ['src/app.ts'] },
        },
      }),
    );
    renderApp(REVIEW);

    const panel = await screen.findByRole('region', { name: 'Needs update' });
    expect(screen.getByTestId('submission-status')).toHaveTextContent('Needs update');
    expect(
      within(panel).getByRole('list', { name: 'Files that clash with main' }),
    ).toHaveTextContent('src/app.ts');
    expect(within(panel).getByRole('link', { name: 'IDE' })).toHaveAttribute(
      'href',
      '/projects/project-1/ide',
    );
    expect(
      await within(panel).findByRole('button', { name: 'Update my copy' }),
    ).toBeInTheDocument();
    expect(await within(panel).findByText(/1 file clashes with main/)).toBeInTheDocument();
  });

  it('tells others it waits for the author', async () => {
    stubApi(
      base('leader', {
        [`GET ${S}`]: {
          status: 200,
          body: { submission: needsUpdate({ viewerActions: ['reject', 'close'] }) },
        },
      }),
    );
    renderApp(REVIEW);
    const panel = await screen.findByRole('region', { name: 'Needs update' });
    expect(panel).toHaveTextContent('Waiting for Grace Hopper to update their copy');
    expect(screen.getByText(/this submission clashes with main/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Update my copy' })).toBeNull();
  });
});

describe('Update my copy on the overview', () => {
  function overview(copy: CopyView, extra: StubRoutes = {}): StubRoutes {
    return {
      'GET /api/auth/me': loggedIn,
      [`GET ${P}`]: { status: 200, body: { project: testProject('member') } },
      [`GET ${P}/repository`]: {
        status: 200,
        body: { repository: testRepository({ status: 'ready', source: 'empty' }) },
      },
      [`GET ${P}/copy`]: { status: 200, body: { copy } },
      ...extra,
    };
  }

  it('previews clashes, updates, and then lists files with conflict markers', async () => {
    const user = userEvent.setup();
    const updated = testCopy({ unresolvedPaths: ['src/app.ts'] });
    const fetchMock = stubApi(
      overview(testCopy({ behind: true, pendingConflictPaths: ['src/app.ts'] }), {
        [`GET ${P}/copy/update`]: {
          status: 200,
          body: { behind: true, conflictPaths: ['src/app.ts'] },
        },
        [`POST ${P}/copy/update`]: {
          status: 200,
          body: { copy: updated, conflictPaths: ['src/app.ts'] },
        },
      }),
    );
    renderApp('/projects/project-1');

    const region = await screen.findByRole('region', { name: 'Main has changed' });
    expect(await within(region).findByText(/1 file clashes with main/)).toBeInTheDocument();
    expect(region).toHaveTextContent('wasn’t updated automatically');
    expect(region).toHaveTextContent('Source Control panel may then list them');

    await user.click(within(region).getByRole('button', { name: 'Update my copy' }));

    const list = await screen.findByRole('list', { name: 'Files with conflict markers' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['src/app.ts']);
    expect(screen.getByRole('status')).toHaveTextContent('1 file has clash markers to fix');
    expect(screen.queryByRole('region', { name: 'Main has changed' })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'POST' && String(url) === `${P}/copy/update`,
      ),
    ).toHaveLength(1);
  });

  it('says so when an update has no clashes', async () => {
    const user = userEvent.setup();
    stubApi(
      overview(testCopy({ behind: true }), {
        [`GET ${P}/copy/update`]: { status: 200, body: { behind: true, conflictPaths: [] } },
        [`POST ${P}/copy/update`]: { status: 200, body: { copy: testCopy(), conflictPaths: [] } },
      }),
    );
    renderApp('/projects/project-1');
    const region = await screen.findByRole('region', { name: 'Main has changed' });
    expect(await within(region).findByText(/No clashes/)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Update my copy' }));
    expect(await screen.findByText('Your copy is up to date with main.')).toBeInTheDocument();
  });

  it('explains a copy that changed during the update', async () => {
    const user = userEvent.setup();
    stubApi(
      overview(testCopy({ behind: true }), {
        [`GET ${P}/copy/update`]: { status: 200, body: { behind: true, conflictPaths: [] } },
        [`POST ${P}/copy/update`]: {
          status: 409,
          body: { error: 'copy_changed', message: 'Changed' },
        },
      }),
    );
    renderApp('/projects/project-1');
    await user.click(await screen.findByRole('button', { name: 'Update my copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was written');
  });

  it('shows which leads opened my copy, and nothing else when up to date', async () => {
    stubApi(overview(testCopy({ helpers: [{ user: lead, at: new Date().toISOString() }] })));
    renderApp('/projects/project-1');
    expect(await screen.findByText('Lee Leader')).toBeInTheDocument();
    expect(screen.getByText(/opened your copy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update my copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Files with conflict markers' })).toBeNull();
  });
});

describe('Update my copy in the IDE toolbar', () => {
  it('shows the banner under the toolbar of my own IDE', async () => {
    const running = testCopy({ containerStatus: 'running', behind: true });
    stubApi({
      'GET /api/auth/me': loggedIn,
      [`GET ${P}`]: { status: 200, body: { project: testProject('member') } },
      [`POST ${P}/copy/ide`]: { status: 200, body: { copy: running } },
      [`GET ${P}/copy`]: { status: 200, body: { copy: running } },
      [`POST ${P}/copy/ide/launch`]: {
        status: 200,
        body: { url: 'http://127.0.0.1:3100/ide-launch?ticket=t1' },
      },
      [`GET ${P}/copy/update`]: { status: 200, body: { behind: true, conflictPaths: [] } },
    });
    renderApp('/projects/project-1/ide');
    expect(await screen.findByTitle('VS Code for Website')).toBeInTheDocument();
    const region = await screen.findByRole('region', { name: 'Main has changed' });
    expect(within(region).getByRole('button', { name: 'Update my copy' })).toBeInTheDocument();
  });
});

describe('Leads open a member’s copy', () => {
  const members = [
    testMember(testUser.id, testUser.name, 'leader'),
    testMember('user-3', 'Cleo Member', 'member'),
  ];

  function membersPage(role: 'leader' | 'member'): StubRoutes {
    return {
      'GET /api/auth/me': loggedIn,
      [`GET ${P}`]: { status: 200, body: { project: testProject(role) } },
      [`GET ${P}/members`]: { status: 200, body: { members } },
      [`GET ${P}/invitations`]: { status: 200, body: { invitations: [] } },
    };
  }

  it('offers a lead Open copy on other members’ rows', async () => {
    stubApi(membersPage('leader'));
    renderApp('/projects/project-1/members');
    const link = await screen.findByRole('link', { name: 'Open copy of Cleo Member' });
    expect(link).toHaveTextContent('Open copy');
    expect(link).toHaveAttribute('href', '/projects/project-1/members/user-3/ide');
    expect(screen.queryByRole('link', { name: `Open copy of ${testUser.name}` })).toBeNull();
  });

  it('offers a plain member no Open copy', async () => {
    stubApi(membersPage('member'));
    renderApp('/projects/project-1/members');
    await screen.findByText('Cleo Member');
    expect(screen.queryByRole('link', { name: /Open copy/ })).not.toBeInTheDocument();
  });

  const M = `${P}/members/user-3/copy`;

  it('opens that member’s copy in the IDE page, headed with their name', async () => {
    const running = testCopy({ containerStatus: 'running' });
    stubApi({
      ...membersPage('leader'),
      [`POST ${M}/ide`]: { status: 200, body: { copy: running } },
      [`GET ${M}`]: { status: 200, body: { copy: running } },
      [`POST ${M}/ide/launch`]: {
        status: 200,
        body: { url: 'http://127.0.0.1:3100/ide-launch?ticket=t1' },
      },
    });
    renderApp('/projects/project-1/members/user-3/ide');

    expect(await screen.findByTitle('VS Code for Cleo Member’s copy')).toHaveAttribute(
      'src',
      'http://127.0.0.1:3100/ide-launch?ticket=t1',
    );
    expect(screen.getByRole('heading', { name: 'Cleo Member’s copy' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to members' })).toHaveAttribute(
      'href',
      '/projects/project-1/members',
    );
    expect(screen.queryByRole('link', { name: 'Submit work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Main has changed' })).not.toBeInTheDocument();
  });

  it.each([
    [403, 'forbidden', 'Only leaders and co-leaders can open a member’s copy.'],
    [404, 'not_found', 'This member has no copy yet'],
  ] as const)('explains a %s', async (status, error, text) => {
    stubApi({
      ...membersPage('leader'),
      [`POST ${M}/ide`]: { status, body: { error, message: 'No' } },
    });
    renderApp('/projects/project-1/members/user-3/ide');
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});

describe('activity wording for merges and copies', () => {
  const entry = (action: string, data: Record<string, unknown> = {}): ActivityEntry => ({
    id: 'a1',
    action,
    actorId: lead.id,
    actorName: lead.name,
    target: 'sub-1',
    data,
    createdAt: '2026-09-28T10:00:00.000Z',
  });

  it('describes the new actions', () => {
    expect(describeActivity(entry('submission.merged', { title: 'Login', sha: 'x' }))).toBe(
      'Lee Leader merged “Login” into main',
    );
    expect(describeActivity(entry('submission.reverted', { title: 'Login' }))).toBe(
      'Lee Leader undid the merge of “Login”',
    );
    expect(describeActivity(entry('copy.helped', { ownerName: 'Cleo Member' }))).toBe(
      'Lee Leader opened Cleo Member’s copy',
    );
    expect(describeActivity(entry('copy.updated', { automatic: false }))).toBe(
      'Lee Leader updated their copy to the latest main',
    );
    expect(
      describeActivity({
        ...entry('copy.updated', { automatic: true }),
        actorId: null,
        actorName: null,
      }),
    ).toBe('A copy was updated to the latest main automatically');
  });
});
