import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SetUpRepositoryRequestSchema,
  type ActivityEntry,
  type FileResponse,
  type ProjectDetail,
  type RepositoryStatus,
  type TreeEntry,
} from '@devspace/shared';
import { languageForPath } from '../../../components/code/languages';
import { describeActivity } from '../../../lib/labels';
import {
  IMPORT_POLL_MS,
  blobUrl,
  decodeRepoPath,
  encodeRepoPath,
  filesUrl,
  formatBytes,
} from '../../../lib/repository';
import {
  loggedIn,
  renderApp,
  requestBody,
  stubApi,
  testProject,
  testRepository,
  testUser,
  type StubReply,
  type StubRoutes,
} from '../../../test/utils';

// Monaco doesn't run in jsdom: the lazily loaded viewer becomes a plain <pre>.
vi.mock('../../../components/code/CodeViewer', () => ({
  default: ({ path, value }: { path: string; value: string }) => (
    <pre data-testid="code-mock" data-path={path}>
      {value}
    </pre>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '/api/projects/project-1';
const enc = encodeURIComponent;

const ready = testRepository({
  status: 'ready',
  source: 'empty',
  lastCommit: {
    sha: 'abc123',
    message: 'Add the login page\n\nWith tests.',
    authorName: 'Ada Lovelace',
    committedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  },
});

function repo(repository: RepositoryStatus): StubReply {
  return { status: 200, body: { repository } };
}

function tree(path: string, entries: TreeEntry[]): StubRoutes {
  return { [`GET ${P}/tree?path=${enc(path)}`]: { status: 200, body: { path, entries } } };
}

function file(path: string, overrides: Partial<FileResponse> = {}): StubRoutes {
  const body: FileResponse = {
    path,
    size: 20,
    isBinary: false,
    tooLarge: false,
    content: 'console.log("hi");\n',
    ...overrides,
  };
  return { [`GET ${P}/file?path=${enc(path)}`]: { status: 200, body } };
}

function entry(path: string, type: TreeEntry['type'], size: number | null = null): TreeEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, type, size };
}

function routes(
  project: ProjectDetail,
  repository: StubReply | (() => StubReply),
  extra: StubRoutes = {},
): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    [`GET ${P}/repository`]: repository,
    ...extra,
  };
}

function nav() {
  return screen.getByRole('navigation', { name: 'Project' });
}

function breadcrumb() {
  return screen.getByRole('navigation', { name: 'Breadcrumb' });
}

// ---------- Navigation ----------

describe('Files link', () => {
  it('shows every member a Files link between Overview and Members', async () => {
    stubApi(routes(testProject('member'), repo(testRepository())));
    renderApp('/projects/project-1');

    await screen.findByRole('heading', { level: 1, name: 'Website' });
    const links = within(nav())
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links).toEqual(['Overview', 'Files', 'Submissions', 'Tasks', 'Members', 'Activity']);
    expect(within(nav()).getByRole('link', { name: 'Files' })).toHaveAttribute(
      'href',
      '/projects/project-1/files',
    );
  });
});

// ---------- Setup ----------

describe('repository setup', () => {
  it('lets a leader start empty, then shows the files', async () => {
    const fetchMock = stubApi(
      routes(testProject('leader'), repo(testRepository()), {
        [`POST ${P}/repository`]: { status: 202, body: { repository: ready } },
        ...tree('', [entry('README.md', 'file', 9)]),
        ...file('README.md', { content: '# Website', size: 9 }),
      }),
    );
    renderApp('/projects/project-1/files');

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Set up the repository' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Start empty' })).toBeChecked();
    expect(screen.queryByLabelText('Git link')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Set up repository' }));

    expect(await screen.findByRole('link', { name: 'README.md' })).toBeInTheDocument();
    expect(
      SetUpRepositoryRequestSchema.parse(requestBody(fetchMock, `POST ${P}/repository`)),
    ).toEqual({ source: 'empty' });
  });

  it('tells a member that a leader sets it up', async () => {
    stubApi(routes(testProject('member'), repo(testRepository())));
    renderApp('/projects/project-1/files');

    expect(
      await screen.findByText(
        "The repository hasn't been set up yet. A leader or co-leader can set it up.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up repository' })).not.toBeInTheDocument();
  });

  it('checks the Git link before sending it and sends the normalized link', async () => {
    const importing = testRepository({
      status: 'importing',
      source: 'import',
      importUrl: 'https://github.com/octo/hello',
    });
    const fetchMock = stubApi(
      routes(testProject('co_leader'), repo(testRepository()), {
        [`POST ${P}/repository`]: { status: 202, body: { repository: importing } },
      }),
    );
    renderApp('/projects/project-1/files');

    await userEvent.click(await screen.findByRole('radio', { name: 'Import from a Git link' }));
    const input = screen.getByLabelText('Git link');
    expect(
      screen.getByText(
        'Public repositories on GitHub, GitLab and Bitbucket are supported, up to 200 MB.',
      ),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Set up repository' });

    await userEvent.click(submit);
    expect(screen.getByText('Paste a Git link')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const tryLink = async (link: string, message: string) => {
      await userEvent.clear(input);
      await userEvent.type(input, link);
      await userEvent.click(submit);
      expect(screen.getByText(message)).toBeInTheDocument();
    };
    await tryLink('github.com/octo/hello', 'Enter a full link starting with https://');
    await tryLink('http://github.com/octo/hello', 'The link must start with https://');
    await tryLink(
      'https://example.com/octo/hello',
      'Only GitHub, GitLab and Bitbucket links are supported',
    );
    await tryLink(
      'https://github.com/octo',
      'The link must point to a repository, like https://github.com/owner/repo',
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    await userEvent.clear(input);
    await userEvent.type(input, 'https://github.com/octo/hello.git');
    await userEvent.click(submit);

    expect(
      await screen.findByText('Importing from https://github.com/octo/hello…'),
    ).toBeInTheDocument();
    expect(requestBody(fetchMock, `POST ${P}/repository`)).toEqual({
      source: 'import',
      url: 'https://github.com/octo/hello',
    });
  });

  it('shows why an import failed and lets the leader try again', async () => {
    const failed = testRepository({
      status: 'failed',
      source: 'import',
      importUrl: 'https://github.com/octo/huge',
      error: 'The repository is larger than 200 MB.',
    });
    const fetchMock = stubApi(
      routes(testProject('leader'), repo(failed), {
        [`POST ${P}/repository`]: {
          status: 202,
          body: { repository: { ...failed, status: 'importing', error: null } },
        },
      }),
    );
    renderApp('/projects/project-1/files');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The repository is larger than 200 MB.',
    );
    expect(screen.getByRole('radio', { name: 'Import from a Git link' })).toBeChecked();
    expect(screen.getByLabelText('Git link')).toHaveValue('https://github.com/octo/huge');

    await userEvent.click(screen.getByRole('button', { name: 'Set up repository' }));
    expect(
      await screen.findByText('Importing from https://github.com/octo/huge…'),
    ).toBeInTheDocument();
    expect(requestBody(fetchMock, `POST ${P}/repository`)).toEqual({
      source: 'import',
      url: 'https://github.com/octo/huge',
    });
  });

  it('shows the server’s reason when setting up fails', async () => {
    stubApi(
      routes(testProject('leader'), repo(testRepository()), {
        [`POST ${P}/repository`]: {
          status: 403,
          body: { error: 'forbidden', message: 'Only leaders can set up the repository.' },
        },
      }),
    );
    renderApp('/projects/project-1/files');

    await userEvent.click(await screen.findByRole('button', { name: 'Set up repository' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only leaders can set up the repository.',
    );
  });
});

// ---------- Importing ----------

describe('importing', () => {
  it('polls every 2 seconds while importing, then shows the files', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const importing = testRepository({
      status: 'importing',
      source: 'import',
      importUrl: 'https://gitlab.com/group/sub/app',
    });
    let current = importing;
    const fetchMock = stubApi(
      routes(testProject('member'), () => repo(current), {
        ...tree('', [entry('src', 'dir')]),
      }),
    );
    renderApp('/projects/project-1/files');

    const status = await screen.findByText('Importing from https://gitlab.com/group/sub/app…');
    expect(status).toHaveAttribute('role', 'status');
    const polls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url) === `${P}/repository`).length;
    const before = polls();

    await act(() => vi.advanceTimersByTimeAsync(IMPORT_POLL_MS));
    await waitFor(() => expect(polls()).toBe(before + 1));
    expect(screen.getByText('Importing from https://gitlab.com/group/sub/app…')).toBeVisible();

    current = { ...ready, source: 'import', importUrl: importing.importUrl };
    await act(() => vi.advanceTimersByTimeAsync(IMPORT_POLL_MS));
    expect(await screen.findByRole('link', { name: 'src' })).toBeInTheDocument();

    // Ready: no more polling.
    const settled = polls();
    await act(() => vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 3));
    expect(polls()).toBe(settled);
  });

  it('goes back to setup when the tree says the repository is not ready', async () => {
    let current = ready;
    stubApi(
      routes(testProject('leader'), () => repo(current), {
        [`GET ${P}/tree?path=`]: () => {
          current = testRepository();
          return {
            status: 409,
            body: { error: 'repository_not_ready', message: 'The repository is not ready.' },
          };
        },
      }),
    );
    renderApp('/projects/project-1/files');

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Set up the repository' }),
    ).toBeInTheDocument();
  });
});

// ---------- Browsing ----------

describe('files browser', () => {
  it('lists folders first with links, sizes, labels, the last commit and the README', async () => {
    stubApi(
      routes(testProject('member'), repo(ready), {
        ...tree('', [
          entry('docs', 'dir'),
          entry('src', 'dir'),
          entry('vendor', 'submodule'),
          entry('.gitignore', 'file', 12),
          entry('big.bin', 'file', 1536),
          entry('current', 'symlink'),
          entry('Readme.MD', 'file', 40),
        ]),
        ...file('Readme.MD', { content: '# Website\n\n<script>alert(1)</script>', size: 40 }),
      }),
    );
    renderApp('/projects/project-1/files');

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
      'docs',
      'src',
      'vendorsubmodule',
      '.gitignore',
      'big.bin',
      'currentsymlink',
      'Readme.MD',
    ]);
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      '/projects/project-1/files/docs',
    );
    expect(screen.getByRole('link', { name: '.gitignore' })).toHaveAttribute(
      'href',
      '/projects/project-1/blob/.gitignore',
    );
    expect(screen.queryByRole('link', { name: 'vendor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'current' })).not.toBeInTheDocument();
    expect(within(rows[3]!).getByText('12 bytes')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('1.5 KB')).toBeInTheDocument();

    expect(screen.getByText('Add the login page').closest('p')).toHaveTextContent(
      'Add the login page — Ada Lovelace, 5 minutes ago',
    );

    const readme = await screen.findByRole('region', { name: 'Readme.MD' });
    // Shown as plain text, never as HTML.
    expect(within(readme).getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(readme.querySelector('script')).toBeNull();
  });

  it('opens nested folders with encoded names and a breadcrumb back up', async () => {
    const folder = 'src/my docs #1/100% ü';
    const fetchMock = stubApi(
      routes(testProject('member'), repo(ready), {
        ...tree(folder, [entry(`${folder}/a b.ts`, 'file', 3)]),
      }),
    );
    const { router } = renderApp(`/projects/project-1/files/${encodeRepoPath(folder)}`);

    const link = await screen.findByRole('link', { name: 'a b.ts' });
    expect(link).toHaveAttribute(
      'href',
      '/projects/project-1/blob/src/my%20docs%20%231/100%25%20%C3%BC/a%20b.ts',
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `${P}/tree?path=src%2Fmy%20docs%20%231%2F100%25%20%C3%BC`,
      ),
    ).toBe(true);

    const crumbs = within(breadcrumb()).getAllByRole('link');
    expect(crumbs.map((c) => [c.textContent, c.getAttribute('href')])).toEqual([
      ['Website', '/projects/project-1/files'],
      ['src', '/projects/project-1/files/src'],
      ['my docs #1', '/projects/project-1/files/src/my%20docs%20%231'],
      ['100% ü', '/projects/project-1/files/src/my%20docs%20%231/100%25%20%C3%BC'],
    ]);
    expect(crumbs[3]).toHaveAttribute('aria-current', 'page');
    expect(router.state.location.pathname).toBe(
      '/projects/project-1/files/src/my%20docs%20%231/100%25%20%C3%BC',
    );
  });

  it('says so when the folder is missing, and rejects invalid paths', async () => {
    stubApi(
      routes(testProject('member'), repo(ready), {
        [`GET ${P}/tree?path=nope`]: {
          status: 404,
          body: { error: 'not_found', message: 'Not found' },
        },
      }),
    );
    const { router } = renderApp('/projects/project-1/files/nope');
    expect(await screen.findByText("This folder doesn't exist on main")).toBeInTheDocument();

    await act(() => router.navigate('/projects/project-1/files/a/%2E%2E/b'));
    expect(await screen.findByText('Invalid path')).toBeInTheDocument();

    await act(() => router.navigate('/projects/project-1/files/%E0%A4%A'));
    expect(await screen.findByText('Invalid path')).toBeInTheDocument();
  });
});

// ---------- File view ----------

describe('file view', () => {
  it('shows a text file in the code viewer with its name, breadcrumb and size', async () => {
    stubApi(
      routes(testProject('member'), repo(ready), {
        ...file('src/app main.ts', { size: 2048, content: 'export const answer = 42;\n' }),
      }),
    );
    renderApp(`/projects/project-1/blob/${encodeRepoPath('src/app main.ts')}`);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'app main.ts' }),
    ).toBeInTheDocument();
    const viewer = await screen.findByTestId('file-viewer');
    expect(await within(viewer).findByTestId('code-mock')).toHaveTextContent(
      'export const answer = 42;',
    );
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(
      within(breadcrumb())
        .getAllByRole('link')
        .map((c) => c.textContent),
    ).toEqual(['Website', 'src']);
    expect(within(breadcrumb()).getByText('app main.ts')).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: 'Files' })).toHaveClass('bg-blue-700');
  });

  it('explains binary and too-large files instead of showing them', async () => {
    stubApi(
      routes(testProject('member'), repo(ready), {
        ...file('logo.png', { isBinary: true, content: null, size: 5000 }),
        ...file('data.csv', { tooLarge: true, content: null, size: 3 * 1024 * 1024 }),
      }),
    );
    const { router } = renderApp('/projects/project-1/blob/logo.png');
    expect(
      await screen.findByText("This file is binary and can't be shown here."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('file-viewer')).not.toBeInTheDocument();

    await act(() => router.navigate('/projects/project-1/blob/data.csv'));
    expect(
      await screen.findByText('This file is too large to show here (3 MB).'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('file-viewer')).not.toBeInTheDocument();
  });

  it('says so when the file is missing', async () => {
    stubApi(
      routes(testProject('member'), repo(ready), {
        [`GET ${P}/file?path=gone.txt`]: {
          status: 404,
          body: { error: 'not_found', message: 'Not found' },
        },
      }),
    );
    renderApp('/projects/project-1/blob/gone.txt');
    expect(await screen.findByText("This file doesn't exist on main")).toBeInTheDocument();
  });
});

// ---------- Overview ----------

describe('overview repository summary', () => {
  it('shows the last commit and a Browse files link when ready', async () => {
    stubApi(routes(testProject('member'), repo(ready)));
    renderApp('/projects/project-1');

    expect(await screen.findByRole('link', { name: 'Browse files' })).toHaveAttribute(
      'href',
      '/projects/project-1/files',
    );
    expect(screen.getByText('Add the login page')).toBeInTheDocument();
  });

  it('tells a member the repository is not set up yet', async () => {
    stubApi(routes(testProject('member'), repo(testRepository())));
    renderApp('/projects/project-1');

    expect(
      await screen.findByText(
        "The repository hasn't been set up yet. A leader or co-leader can set it up.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up the repository' })).not.toBeInTheDocument();
  });
});

// ---------- Helpers ----------

describe('repository helpers', () => {
  it('round-trips paths through URLs', () => {
    for (const path of ['', 'README.md', 'a b/#c/100%/ü.ts', 'src/[id]/page?.tsx']) {
      const url = filesUrl('p', path);
      const encoded = url.slice('/projects/p/files'.length).replace(/^\//, '');
      expect(decodeRepoPath(encoded)).toBe(path);
    }
    expect(blobUrl('p', 'a b/c#d.md')).toBe('/projects/p/blob/a%20b/c%23d.md');
    expect(decodeRepoPath('src/')).toBe('src');
    expect(decodeRepoPath('a//b')).toBeNull();
    expect(decodeRepoPath('..')).toBeNull();
    expect(decodeRepoPath('a%5Cb')).toBeNull();
    expect(decodeRepoPath('%ZZ')).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1023 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('picks a language from the file name', () => {
    expect(languageForPath('src/App.tsx')).toBe('typescript');
    expect(languageForPath('main.PY')).toBe('python');
    expect(languageForPath('ci/deploy.yml')).toBe('yaml');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('.gitignore')).toBe('plaintext');
    expect(languageForPath('notes.xyz')).toBe('plaintext');
  });

  it('describes repository activity', () => {
    const activity = (action: string, data: Record<string, unknown>): ActivityEntry => ({
      id: 'a',
      action,
      actorId: testUser.id,
      actorName: testUser.name,
      target: null,
      data,
      createdAt: '2026-09-27T10:00:00.000Z',
    });
    const url = 'https://github.com/octo/hello';
    expect(describeActivity(activity('repository.created', {}))).toBe(
      'Ada Lovelace started the repository empty',
    );
    expect(describeActivity(activity('repository.imported', { url }))).toBe(
      `Ada Lovelace imported the repository from ${url}`,
    );
    expect(describeActivity(activity('repository.import_failed', { url }))).toBe(
      `Ada Lovelace tried to import from ${url}, but it failed`,
    );
  });
});
