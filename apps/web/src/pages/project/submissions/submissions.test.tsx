import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateCommentRequestSchema,
  CreateReviewRequestSchema,
  CreateSubmissionRequestSchema,
  type ChangedFile,
  type SubmissionDetail,
  type SubmissionFileResponse,
} from '@devspace/shared';
import {
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testComment,
  testCopy,
  testProject,
  testSubmission,
  testUser,
  type StubReply,
  type StubRoutes,
} from '../../../test/utils';
import { describeActivity } from '../../../lib/labels';

// Monaco doesn't run in jsdom: the lazily loaded diff becomes plain text, plus a button that
// acts like selecting lines 2–3 of the new version.
vi.mock('../../../components/code/DiffViewer', () => ({
  default: ({
    path,
    base,
    head,
    onPickLines,
  }: {
    path: string;
    base: string;
    head: string;
    onPickLines?: (pick: { side: 'base' | 'head'; startLine: number; line: number }) => void;
  }) => (
    <div data-testid="diff-mock" data-path={path}>
      <pre data-testid="diff-base">{base}</pre>
      <pre data-testid="diff-head">{head}</pre>
      {onPickLines && (
        <button type="button" onClick={() => onPickLines({ side: 'head', startLine: 2, line: 3 })}>
          Select lines 2–3
        </button>
      )}
    </div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const S = `${P}/submissions/sub-1`;
const enc = encodeURIComponent;

function base(extra: StubRoutes, role: 'leader' | 'member' = 'member'): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project: testProject(role) } },
    ...extra,
  };
}

function detail(submission: SubmissionDetail): StubReply {
  return { status: 200, body: { submission } };
}

function fileRoute(path: string, overrides: Partial<SubmissionFileResponse> = {}): StubRoutes {
  const body: SubmissionFileResponse = {
    path,
    change: 'modified',
    base: { kind: 'text', content: 'one\ntwo\nthree\n' },
    head: { kind: 'text', content: 'one\nTWO\nTHREE\n' },
    ...overrides,
  };
  return { [`GET ${S}/file?path=${enc(path)}`]: { status: 200, body } };
}

function calls(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  ).length;
}

/** A reply that changes after the first call (e.g. a submission re-read after a comment). */
function sequence(...replies: StubReply[]): () => StubReply {
  let n = 0;
  return () => replies[Math.min(n++, replies.length - 1)]!;
}

// ---------- List ----------

describe('Submissions list', () => {
  it('has a Submissions tab and lists active submissions with their status', async () => {
    const summary = testSubmission({ status: 'approved', approvals: 1, commentCount: 2 });
    stubApi(
      base({
        [`GET ${P}/submissions?status=active`]: {
          status: 200,
          body: { submissions: [summary] },
        },
      }),
    );
    renderApp('/projects/project-1/submissions');

    // A cheap text query first: a polling findByRole on the file's first (cold) render can pass
    // the 1 s limit.
    await screen.findByText('Add the login page', {}, { timeout: 4000 });
    expect(screen.getByRole('link', { name: 'Add the login page' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/sub-1',
    );
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(
      screen.getByText(/Grace Hopper · version 1 · 1 file · 2 comments · 1 approval/),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect(within(nav).getByRole('link', { name: 'Submissions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Submit work' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/new',
    );
  });

  it('switches to all submissions', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      base({
        [`GET ${P}/submissions?status=active`]: { status: 200, body: { submissions: [] } },
        [`GET ${P}/submissions?status=all`]: {
          status: 200,
          body: { submissions: [testSubmission({ status: 'closed' })] },
        },
      }),
    );
    const { router } = renderApp('/projects/project-1/submissions');

    expect(await screen.findByText(/No open submissions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?status=all');
    expect(calls(fetchMock, `GET ${P}/submissions?status=all`)).toBe(1);
  });

  it('shows the server’s error with a retry', async () => {
    stubApi(
      base({
        [`GET ${P}/submissions?status=active`]: {
          status: 500,
          body: { error: 'internal', message: 'Database is down' },
        },
      }),
    );
    renderApp('/projects/project-1/submissions');
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

// ---------- New submission ----------

const changed: ChangedFile[] = [
  { path: 'notes/a.txt', change: 'modified', openSubmissionId: null },
  { path: 'notes/b.txt', change: 'added', openSubmissionId: null },
  { path: 'src/locked.ts', change: 'deleted', openSubmissionId: 'sub-9' },
];

function changesRoute(files: ChangedFile[] = changed): StubRoutes {
  return { [`GET ${P}/copy/changes`]: { status: 200, body: { baseSha: 'a'.repeat(40), files } } };
}

describe('New submission page', () => {
  it('ticks every changed file except locked ones, and submits the picked files', async () => {
    const user = userEvent.setup();
    const created = testSubmission({
      author: { id: testUser.id, name: testUser.name },
      title: 'Notes',
      files: [{ path: 'notes/a.txt', change: 'modified' }],
      viewerActions: ['update', 'comment', 'close'],
    });
    const fetchMock = stubApi(
      base({
        ...changesRoute(),
        [`POST ${P}/submissions`]: { status: 201, body: { submission: created } },
        [`GET ${S}`]: detail(created),
        ...fileRoute('notes/a.txt'),
      }),
    );
    const { router } = renderApp('/projects/project-1/submissions/new');

    const a = await screen.findByRole('checkbox', { name: 'notes/a.txt' });
    const b = screen.getByRole('checkbox', { name: 'notes/b.txt' });
    const locked = screen.getByRole('checkbox', { name: 'src/locked.ts' });
    expect(a).toBeChecked();
    expect(b).toBeChecked();
    expect(locked).not.toBeChecked();
    expect(locked).toBeDisabled();
    expect(screen.getByRole('link', { name: 'another open submission' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/sub-9',
    );

    await user.click(b);
    await user.type(screen.getByLabelText('Title'), 'Notes');
    await user.type(screen.getByLabelText('Description'), 'Fixes typos');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/projects/project-1/submissions/sub-1'),
    );
    expect(
      CreateSubmissionRequestSchema.parse(requestBody(fetchMock, `POST ${P}/submissions`)),
    ).toEqual({ title: 'Notes', description: 'Fixes typos', paths: ['notes/a.txt'] });
    expect(await screen.findByTestId('submission-status')).toHaveTextContent('Open');
  });

  it('checks the title and the file choice before sending', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(base(changesRoute()));
    renderApp('/projects/project-1/submissions/new');

    await user.click(await screen.findByRole('button', { name: 'Untick all' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Enter a title')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one file')).toBeInTheDocument();
    expect(calls(fetchMock, `POST ${P}/submissions`)).toBe(0);
  });

  it('explains a file already in another open submission (409)', async () => {
    const user = userEvent.setup();
    stubApi(
      base({
        ...changesRoute(),
        [`POST ${P}/submissions`]: {
          status: 409,
          body: {
            error: 'file_in_open_submission',
            message: 'File is in an open submission',
            details: { paths: ['notes/a.txt'], submissionId: 'sub-7' },
          },
        },
      }),
    );
    renderApp('/projects/project-1/submissions/new');
    await user.type(await screen.findByLabelText('Title'), 'Notes');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These files are already in another of your open submissions: notes/a.txt.',
    );
  });

  it('sends a member without a copy to the IDE (409 no_copy)', async () => {
    stubApi(
      base({
        [`GET ${P}/copy/changes`]: {
          status: 409,
          body: { error: 'no_copy', message: 'You have no copy yet' },
        },
      }),
    );
    renderApp('/projects/project-1/submissions/new');
    expect(
      await screen.findByText(/You don’t have a copy of this project yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open IDE' })).toHaveAttribute(
      'href',
      '/projects/project-1/ide',
    );
  });

  it('says when nothing has changed', async () => {
    stubApi(base(changesRoute([])));
    renderApp('/projects/project-1/submissions/new');
    expect(await screen.findByText(/Nothing to submit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });

  it('explains when every changed file is already in an open submission', async () => {
    stubApi(
      base(
        changesRoute([
          { path: 'README.md', change: 'modified', openSubmissionId: 'sub-9' },
          { path: 'practice.cpp', change: 'added', openSubmissionId: 'sub-9' },
        ]),
      ),
    );
    renderApp('/projects/project-1/submissions/new');
    expect(await screen.findByText(/Nothing new to submit/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your open submission' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/sub-9',
    );
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });

  it('is linked from the IDE toolbar', async () => {
    stubApi(
      base({
        [`POST ${P}/copy/ide`]: {
          status: 200,
          body: { copy: testCopy({ containerStatus: 'stopped' }) },
        },
      }),
    );
    renderApp('/projects/project-1/ide');
    expect(await screen.findByRole('link', { name: 'Submit work' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/new',
    );
  });
});

describe('Update submission page', () => {
  it('pre-ticks the current files and posts an update', async () => {
    const user = userEvent.setup();
    const mine = testSubmission({
      author: { id: testUser.id, name: testUser.name },
      title: 'Notes',
      description: 'First try',
      files: [{ path: 'notes/a.txt', change: 'modified' }],
      viewerActions: ['update', 'comment', 'close'],
    });
    const updated = {
      ...mine,
      version: 2,
      files: [...mine.files, { path: 'notes/b.txt', change: 'added' as const }],
    };
    const fetchMock = stubApi(
      base({
        [`GET ${S}`]: sequence(detail(mine), detail(updated)),
        ...changesRoute([
          { path: 'notes/a.txt', change: 'modified', openSubmissionId: 'sub-1' },
          { path: 'notes/b.txt', change: 'added', openSubmissionId: null },
        ]),
        [`POST ${S}/update`]: detail(updated),
        ...fileRoute('notes/a.txt'),
        ...fileRoute('notes/b.txt', { change: 'added', base: { kind: 'none' } }),
      }),
    );
    const { router } = renderApp('/projects/project-1/submissions/sub-1/update');

    // Its own submission doesn't lock a file.
    const a = await screen.findByRole('checkbox', { name: 'notes/a.txt' });
    expect(a).toBeChecked();
    expect(a).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'notes/b.txt' })).not.toBeChecked();
    expect(screen.getByLabelText('Title')).toHaveValue('Notes');
    expect(screen.getByText(/Updating makes version 2/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'notes/b.txt' }));
    await user.click(screen.getByRole('button', { name: 'Update submission' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/projects/project-1/submissions/sub-1'),
    );
    expect(requestBody(fetchMock, `POST ${S}/update`)).toEqual({
      title: 'Notes',
      description: 'First try',
      paths: ['notes/a.txt', 'notes/b.txt'],
    });
  });
});

// ---------- Review ----------

describe('Review page', () => {
  it('shows the author their own actions only: no Approve', async () => {
    stubApi(
      base({
        [`GET ${S}`]: detail(
          testSubmission({
            author: { id: testUser.id, name: testUser.name },
            description: 'Adds a form',
            viewerActions: ['update', 'comment', 'respondSuggestion', 'close'],
          }),
        ),
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    expect(await screen.findByRole('heading', { name: 'Add the login page' })).toBeInTheDocument();
    expect(screen.getByTestId('submission-status')).toHaveTextContent('Open');
    expect(screen.getByText('Adds a form')).toBeInTheDocument();
    const actions = screen.getByRole('group', { name: 'Actions' });
    expect(within(actions).getByRole('link', { name: 'Update' })).toHaveAttribute(
      'href',
      '/projects/project-1/submissions/sub-1/update',
    );
    expect(within(actions).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

    const region = screen.getByRole('region', { name: 'src/app.ts' });
    expect(await within(region).findByTestId('diff-head')).toHaveTextContent('TWO');
    expect(within(region).getByTestId('diff-base')).toHaveTextContent('two');
  });

  it('shows no action buttons to a viewer without any', async () => {
    stubApi(base({ [`GET ${S}`]: detail(testSubmission()), ...fileRoute('src/app.ts') }));
    renderApp('/projects/project-1/submissions/sub-1');
    await screen.findByTestId('submission-status');
    expect(screen.queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comment on a line' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
  });

  it('lets a reviewer approve, and shows the new status', async () => {
    const user = userEvent.setup();
    const open = testSubmission({
      viewerActions: ['comment', 'suggest', 'approve', 'requestChanges'],
    });
    const approved: SubmissionDetail = {
      ...open,
      status: 'approved',
      approvals: 1,
      reviews: [
        {
          id: 'review-1',
          reviewer: { id: testUser.id, name: testUser.name },
          decision: 'approved',
          body: 'Nice work',
          version: 1,
          stale: false,
          createdAt: '2026-09-28T11:00:00.000Z',
        },
      ],
    };
    const fetchMock = stubApi(
      base({
        [`GET ${S}`]: detail(open),
        [`POST ${S}/reviews`]: detail(approved),
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve' });
    await user.type(within(dialog).getByLabelText('Comment (optional)'), 'Nice work');
    await user.click(within(dialog).getByRole('button', { name: 'Approve submission' }));

    await waitFor(() =>
      expect(screen.getByTestId('submission-status')).toHaveTextContent('Approved'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(CreateReviewRequestSchema.parse(requestBody(fetchMock, `POST ${S}/reviews`))).toEqual({
      decision: 'approved',
      body: 'Nice work',
    });
    expect(screen.getByText('Nice work')).toBeInTheDocument();
  });

  it('explains a refused self-approval (403 own_submission)', async () => {
    const user = userEvent.setup();
    stubApi(
      base({
        [`GET ${S}`]: detail(testSubmission({ viewerActions: ['approve'] })),
        [`POST ${S}/reviews`]: {
          status: 403,
          body: { error: 'own_submission', message: 'You cannot approve your own submission' },
        },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Approve submission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You can’t review your own submission.',
    );
  });

  it('adds a line comment from the form and shows its thread', async () => {
    const user = userEvent.setup();
    const open = testSubmission({ viewerActions: ['comment', 'approve'] });
    const lineComment = testComment({
      path: 'src/app.ts',
      side: 'head',
      line: 2,
      startLine: 2,
      body: 'Why upper case?',
    });
    const fetchMock = stubApi(
      base({
        [`GET ${S}`]: sequence(
          detail(open),
          detail({ ...open, commentCount: 1, comments: [lineComment] }),
        ),
        [`POST ${S}/comments`]: { status: 201, body: { comment: lineComment } },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    const region = await screen.findByRole('region', { name: 'src/app.ts' });
    await user.click(within(region).getByRole('button', { name: 'Comment on a line' }));
    await user.type(within(region).getByLabelText('Line'), '2');
    await user.type(within(region).getByLabelText('Comment'), 'Why upper case?');
    await user.click(within(region).getByRole('button', { name: 'Add comment' }));

    const thread = await within(region).findByTestId('comment-thread');
    expect(thread).toHaveTextContent('Line 2 (new version)');
    expect(thread).toHaveTextContent('Why upper case?');
    expect(CreateCommentRequestSchema.parse(requestBody(fetchMock, `POST ${S}/comments`))).toEqual({
      body: 'Why upper case?',
      path: 'src/app.ts',
      side: 'head',
      line: 2,
    });
    expect(calls(fetchMock, `GET ${S}`)).toBe(2);
  });

  it('suggests a change for lines picked in the diff', async () => {
    const user = userEvent.setup();
    const open = testSubmission({ viewerActions: ['comment', 'suggest'] });
    const fetchMock = stubApi(
      base({
        [`GET ${S}`]: detail(open),
        [`POST ${S}/comments`]: {
          status: 201,
          body: {
            comment: testComment({ path: 'src/app.ts', side: 'head', line: 3, startLine: 2 }),
          },
        },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    const region = await screen.findByRole('region', { name: 'src/app.ts' });
    await user.click(await within(region).findByRole('button', { name: 'Select lines 2–3' }));
    expect(within(region).getByLabelText('Range starts at')).toHaveValue(2);
    expect(within(region).getByLabelText('Line')).toHaveValue(3);
    await user.click(within(region).getByLabelText('Suggest a change to these lines'));
    const replacement = within(region).getByLabelText('Suggested replacement');
    expect(replacement).toHaveValue('TWO\nTHREE');
    await user.clear(replacement);
    await user.type(replacement, 'two{Enter}three');
    await user.type(within(region).getByLabelText('Comment'), 'Keep lower case');
    await user.click(within(region).getByRole('button', { name: 'Add comment' }));

    await waitFor(() => expect(calls(fetchMock, `POST ${S}/comments`)).toBe(1));
    expect(requestBody(fetchMock, `POST ${S}/comments`)).toEqual({
      body: 'Keep lower case',
      path: 'src/app.ts',
      side: 'head',
      line: 3,
      startLine: 2,
      suggestion: 'two\nthree',
    });
  });

  it('lets the author accept a suggestion, and explains a stale one', async () => {
    const user = userEvent.setup();
    const suggestion = testComment({
      id: 'c-1',
      author: { id: 'user-3', name: 'Alan Turing' },
      path: 'src/app.ts',
      side: 'head',
      line: 3,
      startLine: 2,
      body: 'Keep lower case',
      suggestion: 'two\nthree',
      suggestionStatus: 'pending',
    });
    const mine = testSubmission({
      author: { id: testUser.id, name: testUser.name },
      comments: [suggestion],
      viewerActions: ['update', 'comment', 'respondSuggestion', 'close'],
    });
    let attempts = 0;
    const fetchMock = stubApi(
      base({
        [`GET ${S}`]: detail(mine),
        [`POST ${S}/comments/c-1/suggestion`]: (): StubReply => {
          attempts += 1;
          return attempts === 1
            ? { status: 409, body: { error: 'suggestion_stale', message: 'Lines changed' } }
            : detail({
                ...mine,
                version: 2,
                headSha: 'c'.repeat(40),
                comments: [{ ...suggestion, suggestionStatus: 'accepted' }],
              });
        },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    const thread = await screen.findByTestId('comment-thread');
    expect(thread).toHaveTextContent('Lines 2–3 (new version)');
    expect(thread).toHaveTextContent('Pending');
    await user.click(within(thread).getByRole('button', { name: 'Accept suggestion' }));
    expect(await within(thread).findByRole('alert')).toHaveTextContent(
      'Those lines in your copy have changed since this suggestion was made',
    );

    await user.click(within(thread).getByRole('button', { name: 'Accept suggestion' }));
    await waitFor(() => expect(screen.getByTestId('comment-thread')).toHaveTextContent('Accepted'));
    expect(screen.queryByRole('button', { name: 'Accept suggestion' })).not.toBeInTheDocument();
    expect(requestBody(fetchMock, `POST ${S}/comments/c-1/suggestion`)).toEqual({
      decision: 'accept',
    });
  });

  it('shows outdated comments, stale reviews, replies and binary files', async () => {
    const parent = testComment({
      id: 'c-1',
      path: 'logo.png',
      side: 'head',
      line: 1,
      startLine: 1,
      body: 'Blurry',
      outdated: true,
    });
    const reply = testComment({
      id: 'c-2',
      parentId: 'c-1',
      body: 'Fixed now',
      author: { id: 'user-2', name: 'Grace Hopper' },
    });
    stubApi(
      base({
        [`GET ${S}`]: detail(
          testSubmission({
            version: 2,
            files: [{ path: 'logo.png', change: 'added' }],
            comments: [parent, reply],
            reviews: [
              {
                id: 'r-1',
                reviewer: { id: 'user-3', name: 'Alan Turing' },
                decision: 'approved',
                body: null,
                version: 1,
                stale: true,
                createdAt: '2026-09-28T11:00:00.000Z',
              },
            ],
            viewerActions: ['comment'],
          }),
        ),
        [`GET ${S}/file?path=${enc('logo.png')}`]: {
          status: 200,
          body: {
            path: 'logo.png',
            change: 'added',
            base: { kind: 'none' },
            head: { kind: 'binary' },
          },
        },
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    const thread = await screen.findByTestId('comment-thread');
    expect(thread).toHaveTextContent('Outdated');
    expect(thread).toHaveTextContent('Blurry');
    expect(thread).toHaveTextContent('Fixed now');
    expect(screen.getByText(/Stale: given before the latest update/)).toBeInTheDocument();
    expect(await screen.findByText(/This file is binary/)).toBeInTheDocument();
    expect(screen.queryByTestId('diff-mock')).not.toBeInTheDocument();
  });

  it('asks a leader for a reason before rejecting', async () => {
    const user = userEvent.setup();
    const open = testSubmission({
      viewerActions: ['comment', 'approve', 'requestChanges', 'reject', 'close'],
    });
    const fetchMock = stubApi(
      base(
        {
          [`GET ${S}`]: detail(open),
          [`POST ${S}/reject`]: detail({
            ...open,
            status: 'rejected',
            rejectReason: 'Out of scope',
            viewerActions: ['comment'],
          }),
          ...fileRoute('src/app.ts'),
        },
        'leader',
      ),
    );
    renderApp('/projects/project-1/submissions/sub-1');

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject submission' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject submission' }));
    expect(within(dialog).getByText('Give a reason')).toBeInTheDocument();
    expect(calls(fetchMock, `POST ${S}/reject`)).toBe(0);

    await user.type(within(dialog).getByLabelText('Reason'), 'Out of scope');
    await user.click(within(dialog).getByRole('button', { name: 'Reject submission' }));
    await waitFor(() =>
      expect(screen.getByTestId('submission-status')).toHaveTextContent('Rejected'),
    );
    expect(screen.getByText('Out of scope')).toBeInTheDocument();
    expect(requestBody(fetchMock, `POST ${S}/reject`)).toEqual({ reason: 'Out of scope' });
    expect(screen.queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('explains an action on a submission that is no longer active (409)', async () => {
    const user = userEvent.setup();
    stubApi(
      base({
        [`GET ${S}`]: detail(testSubmission({ viewerActions: ['close'] })),
        [`POST ${S}/close`]: {
          status: 409,
          body: { error: 'submission_not_active', message: 'Not active' },
        },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Close submission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This submission is no longer open');
  });

  it('says when there is no such submission', async () => {
    stubApi(
      base({ [`GET ${S}`]: { status: 404, body: { error: 'not_found', message: 'Not found' } } }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    expect(
      await screen.findByRole('heading', { name: 'Submission not found' }),
    ).toBeInTheDocument();
  });
});

describe('Submission messages', () => {
  it('shows the field problem from a refused line comment (400)', async () => {
    const user = userEvent.setup();
    stubApi(
      base({
        [`GET ${S}`]: detail(testSubmission({ viewerActions: ['comment'] })),
        [`POST ${S}/comments`]: {
          status: 400,
          body: {
            error: 'validation_error',
            message: 'Invalid request',
            fields: { line: ['That line is not in the file'] },
          },
        },
        ...fileRoute('src/app.ts'),
      }),
    );
    renderApp('/projects/project-1/submissions/sub-1');
    const region = await screen.findByRole('region', { name: 'src/app.ts' });
    await user.click(within(region).getByRole('button', { name: 'Comment on a line' }));
    await user.type(within(region).getByLabelText('Line'), '99');
    await user.type(within(region).getByLabelText('Comment'), 'Hmm');
    await user.click(within(region).getByRole('button', { name: 'Add comment' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'That line is not in the file',
    );
  });

  it('describes submission activity', () => {
    const entry = (action: string, data: Record<string, unknown> = {}) =>
      describeActivity({
        id: 'a',
        action,
        actorId: 'user-1',
        actorName: 'Ada',
        target: 'sub-1',
        data,
        createdAt: '2026-09-28T10:00:00.000Z',
      });
    expect(entry('submission.created', { title: 'Notes' })).toBe(
      'Ada submitted “Notes” for review',
    );
    expect(entry('submission.reviewed', { decision: 'approved' })).toBe(
      'Ada approved a submission',
    );
    expect(entry('submission.reviewed', { decision: 'changes_requested' })).toBe(
      'Ada requested changes on a submission',
    );
    expect(entry('submission.suggestion_accepted')).toBe('Ada accepted a suggested change');
  });
});
