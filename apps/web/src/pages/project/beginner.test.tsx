import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GettingStartedView, ProjectDetail, TemplateId } from '@devspace/shared';
import { HelpTip } from '../../components/HelpTip';
import { safePreviewUrl } from '../../lib/copies';
import { GLOSSARY } from '../../lib/glossary';
import {
  loggedIn,
  renderApp,
  requestBody,
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
const IDE_ORIGIN = 'http://127.0.0.1:3100';

// ---------- Help tips ----------

describe('help tips', () => {
  it('opens and closes a glossary explanation from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <p>
        Main <HelpTip term="main" />
      </p>,
    );
    const button = screen.getByRole('button', { name: 'Explain “main”' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(GLOSSARY.main.help)).not.toBeInTheDocument();

    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('help-tip')).toHaveTextContent(GLOSSARY.main.help);
    expect(screen.getByTestId('help-tip').parentElement).toHaveAttribute('aria-live', 'polite');

    await user.keyboard('{Escape}');
    expect(screen.queryByText(GLOSSARY.main.help)).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on a click outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <HelpTip label="Preview">Starts your app.</HelpTip>
        <button type="button">Elsewhere</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Explain “Preview”' }));
    expect(screen.getByText('Starts your app.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByText('Starts your app.')).not.toBeInTheDocument();
  });

  it('uses the glossary words for a clash and main', () => {
    expect(GLOSSARY.clash.help).toContain('(a “conflict”)');
    expect(GLOSSARY.main.help).toContain('shared version');
  });
});

// ---------- Getting started ----------

const LEAD_STEPS = [
  'setup',
  'invite',
  'openIde',
  'change',
  'preview',
  'submit',
  'reviewed',
] as const;

function view(done: readonly string[], hidden = false, ids: readonly string[] = LEAD_STEPS) {
  return {
    hidden,
    steps: ids.map((id) => ({ id, done: done.includes(id) })),
  } as GettingStartedView;
}

function overview(project: ProjectDetail, checklist: StubReply | (() => StubReply), extra = {}) {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project } },
    [`GET ${P}/repository`]: {
      status: 200,
      body: { repository: testRepository({ status: 'ready', source: 'empty' }) },
    },
    [`GET ${P}/copy`]: { status: 200, body: { copy: null } },
    [`GET ${P}/getting-started`]: checklist,
    ...extra,
  } satisfies StubRoutes;
}

function steps() {
  return screen.getAllByTestId('getting-started-step');
}

describe('getting started card', () => {
  it('shows a leader every step, ticks the done ones and points at the next one', async () => {
    stubApi(overview(testProject('leader'), { status: 200, body: view(['setup', 'openIde']) }));
    renderApp('/projects/project-1');

    const card = await screen.findByRole('region', { name: 'Getting started' });
    expect(within(card).getByText('2 of 7 done')).toBeInTheDocument();
    expect(steps().map((s) => s.dataset.step)).toEqual([...LEAD_STEPS]);
    expect(steps().map((s) => s.dataset.done)).toEqual([
      'true',
      'false',
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    // The first step not done yet is the current one, with its "how" and a button to do it.
    const invite = steps()[1]!;
    expect(invite).toHaveAttribute('aria-current', 'step');
    expect(invite).toHaveTextContent('Invite a teammate');
    expect(invite).toHaveTextContent('(not done yet)');
    expect(within(invite).getByRole('link', { name: 'Invite someone' })).toHaveAttribute(
      'href',
      '/projects/project-1/members',
    );
    // Done steps say so and offer nothing to do.
    expect(steps()[0]).toHaveTextContent('(done)');
    expect(within(steps()[0]!).queryByRole('link')).not.toBeInTheDocument();
    // Every open step links somewhere useful.
    expect(
      within(steps()[5]!).getByRole('link', { name: 'Pick changes to submit' }),
    ).toHaveAttribute('href', '/projects/project-1/submissions/new');
  });

  it('shows a member the five steps the API gives', async () => {
    const ids = LEAD_STEPS.slice(2);
    stubApi(overview(testProject('member'), { status: 200, body: view([], false, ids) }));
    renderApp('/projects/project-1');

    await screen.findByRole('region', { name: 'Getting started' });
    expect(steps().map((s) => s.dataset.step)).toEqual([...ids]);
    expect(screen.getByText('0 of 5 done')).toBeInTheDocument();
    expect(within(steps()[0]!).getByRole('link', { name: 'Open your copy' })).toHaveAttribute(
      'href',
      '/projects/project-1/ide',
    );
    // Only the repository card's button is called "Open IDE", so tests and people find one.
    expect(await screen.findAllByRole('link', { name: 'Open IDE' })).toHaveLength(1);
  });

  it('hides and shows again', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      overview(
        testProject('member'),
        { status: 200, body: view([]) },
        {
          [`POST ${P}/getting-started/hide`]: { status: 200, body: view([], true) },
          [`POST ${P}/getting-started/show`]: { status: 200, body: view([]) },
        },
      ),
    );
    renderApp('/projects/project-1');

    await user.click(await screen.findByRole('button', { name: 'Hide getting started' }));
    await user.click(await screen.findByRole('button', { name: 'Show getting started' }));
    expect(await screen.findByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    const posts = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => String(url));
    expect(posts).toEqual([`${P}/getting-started/hide`, `${P}/getting-started/show`]);
  });

  it('says “You’re all set!” once when every step is done, then hides itself', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi(
      overview(
        testProject('leader'),
        { status: 200, body: view(LEAD_STEPS) },
        {
          [`POST ${P}/getting-started/hide`]: { status: 200, body: view(LEAD_STEPS, true) },
        },
      ),
    );
    renderApp('/projects/project-1');

    expect(await screen.findByText(/You’re all set!/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === `${P}/getting-started/hide`),
      ).toHaveLength(1),
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/You’re all set!/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show getting started' })).toBeInTheDocument();
  });

  it('never celebrates when the card was already hidden', async () => {
    stubApi(overview(testProject('leader'), { status: 200, body: view(LEAD_STEPS, true) }));
    renderApp('/projects/project-1');
    expect(await screen.findByRole('button', { name: 'Show getting started' })).toBeInTheDocument();
    expect(screen.queryByText(/You’re all set!/)).not.toBeInTheDocument();
  });
});

// ---------- Preview ----------

function ideRoutes(template: TemplateId | null, extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/auth/me': loggedIn,
    [`GET ${P}`]: { status: 200, body: { project: testProject('member') } },
    [`GET ${P}/repository`]: {
      status: 200,
      body: {
        repository: testRepository({
          status: 'ready',
          source: template ? 'template' : 'empty',
          template,
        }),
      },
    },
    [`POST ${P}/copy/ide`]: {
      status: 200,
      body: { copy: testCopy({ containerStatus: 'running' }) },
    },
    [`POST ${P}/copy/ide/launch`]: {
      status: 200,
      body: { url: `${IDE_ORIGIN}/ide-launch?ticket=ide` },
    },
    ...extra,
  };
}

/** A stand-in for the tab window.open returns. */
function fakeTab() {
  const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  return { tab, open };
}

const PREVIEW = `POST ${P}/copy/preview/launch`;
const previewUrl = `${IDE_ORIGIN}/ide-launch?ticket=p1&next=__preview/8080/`;

describe('Preview button', () => {
  it('starts at the template’s port and opens the launch URL in a new tab', async () => {
    const user = userEvent.setup();
    const { tab, open } = fakeTab();
    const fetchMock = stubApi(
      ideRoutes('html', { [PREVIEW]: { status: 200, body: { url: previewUrl } } }),
    );
    renderApp('/projects/project-1/ide');

    await screen.findByTitle('VS Code for Website');
    const port = await screen.findByLabelText('Port');
    await waitFor(() => expect(port).toHaveValue(8080));
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => expect(tab.location.href).toBe(previewUrl));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    // The new tab can't reach back into the app.
    expect(tab.opener).toBeNull();
    expect(requestBody(fetchMock, PREVIEW)).toEqual({ port: 8080 });
  });

  it('lets the member pick another port', async () => {
    const user = userEvent.setup();
    const { tab } = fakeTab();
    const url = `${IDE_ORIGIN}/ide-launch?ticket=p2&next=__preview/5000/`;
    const fetchMock = stubApi(ideRoutes('react', { [PREVIEW]: { status: 200, body: { url } } }));
    renderApp('/projects/project-1/ide');

    const port = await screen.findByLabelText('Port');
    await waitFor(() => expect(port).toHaveValue(5173));
    await screen.findByTitle('VS Code for Website');
    await user.clear(port);
    await user.type(port, '5000');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(tab.location.href).toBe(url));
    expect(requestBody(fetchMock, PREVIEW)).toEqual({ port: 5000 });
  });

  it('hides the port field when the template has no port, and asks for one first', async () => {
    const user = userEvent.setup();
    const { open } = fakeTab();
    const fetchMock = stubApi(ideRoutes('python'));
    renderApp('/projects/project-1/ide');

    await screen.findByTitle('VS Code for Website');
    expect(screen.queryByLabelText('Port')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByLabelText('Port')).toHaveValue(null);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type the port your app uses');
    await user.type(screen.getByLabelText('Port'), '3000');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('3000 is used by the IDE');
    expect(open).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('preview'))).toBe(false);
  });

  it('never opens a URL that isn’t on the IDE’s site', async () => {
    const user = userEvent.setup();
    const { tab } = fakeTab();
    stubApi(
      ideRoutes('html', {
        [PREVIEW]: { status: 200, body: { url: 'https://evil.example/ide-launch?ticket=x' } },
      }),
    );
    renderApp('/projects/project-1/ide');

    await screen.findByTitle('VS Code for Website');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected preview address');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('about:blank');
  });

  it('explains when the IDE stopped', async () => {
    const user = userEvent.setup();
    const { tab } = fakeTab();
    stubApi(
      ideRoutes('html', {
        [PREVIEW]: {
          status: 409,
          body: { error: 'ide_not_running', message: 'The IDE is not running.' },
        },
      }),
    );
    renderApp('/projects/project-1/ide');

    await screen.findByTitle('VS Code for Website');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Start it again');
    expect(tab.close).toHaveBeenCalled();
  });

  it('offers a link when the browser blocks the new tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    stubApi(ideRoutes('html', { [PREVIEW]: { status: 200, body: { url: previewUrl } } }));
    renderApp('/projects/project-1/ide');

    await screen.findByTitle('VS Code for Website');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    const link = await screen.findByRole('link', { name: 'Open the preview' });
    expect(link).toHaveAttribute('href', previewUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('safePreviewUrl', () => {
  it('accepts only absolute http(s) URLs on the IDE’s site', () => {
    expect(safePreviewUrl(previewUrl, IDE_ORIGIN)).toBe(previewUrl);
    expect(safePreviewUrl(previewUrl, null)).toBeNull();
    expect(safePreviewUrl('/ide-launch?ticket=x', IDE_ORIGIN)).toBeNull();
    expect(safePreviewUrl('javascript:alert(1)', IDE_ORIGIN)).toBeNull();
    expect(safePreviewUrl('http://127.0.0.1:3101/ide-launch', IDE_ORIGIN)).toBeNull();
    // Never the app's own origin, even if the IDE were (wrongly) set up there.
    expect(safePreviewUrl(`${window.location.origin}/x`, window.location.origin)).toBeNull();
  });
});
