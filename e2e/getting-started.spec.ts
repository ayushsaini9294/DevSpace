import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import {
  acceptDialogs,
  bareGit,
  copyFolder,
  createLeaderWithProject,
  projectIdFrom,
  projectNav,
  writeInCopy,
  type LeaderProject,
} from './helpers';

// Phase 11 Done-when: someone new creates a project from a template and makes their first
// submission by following the getting-started checklist. Real IDE containers (image
// devspace-ide:4, the IDE network and firewall), real apps started in them, and Preview through
// the IDE site's `/ide/<copyId>/__preview/<port>/` path.

const IDE_ORIGIN = process.env.IDE_ORIGIN || 'http://127.0.0.1:3100';
const TEMPLATES_DIR = resolve('apps/api/templates');

test.describe.configure({ timeout: 360_000 });

const started: string[] = [];

test.afterAll(() => {
  // Remove the containers these tests started (their copies' files stay with the test data).
  for (const copyId of started) {
    try {
      docker('rm', '-f', containerName(copyId));
    } catch {
      // already gone
    }
  }
});

function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function containerName(copyId: string) {
  return `devspace-ide-${copyId}`;
}

/**
 * Runs a shell command in the copy's IDE container as its terminal would: with the IDE server's
 * DEVSPACE_PREVIEW_* environment (set by the image's start script; `docker exec` doesn't inherit
 * it), in /home/workspace.
 */
function inContainer(copyId: string, command: string, detach = false) {
  const prelude =
    'pid="$(ls /proc | grep -E "^[0-9]+$" | sort -n | sed -n 2p)"; ' +
    'eval "$(tr "\\0" "\\n" <"/proc/$pid/environ" | grep "^DEVSPACE_PREVIEW_" | sed "s/^/export /; s/=\\(.*\\)$/=\\"\\1\\"/")"; ' +
    'cd /home/workspace; ';
  return docker(
    'exec',
    ...(detach ? ['-d'] : []),
    containerName(copyId),
    'bash',
    '-c',
    prelude + command,
  );
}

/** Does something answer HTTP on `port` inside the copy's container? */
function appAnswers(copyId: string, port: number) {
  try {
    return (
      docker(
        'exec',
        containerName(copyId),
        'curl',
        '-s',
        '-m',
        '3',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `http://127.0.0.1:${port}/`,
      ) !== '000'
    );
  } catch {
    return false;
  }
}

/** Every file in a template folder, as repository paths, sorted. */
function templateFiles(id: string) {
  const root = join(TEMPLATES_DIR, id);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

async function getCopy(page: Page, projectId: string) {
  const res = await page.request.get(`/api/projects/${projectId}/copy`);
  expect(res.status()).toBe(200);
  return (await res.json()).copy as { id: string; containerStatus: string } | null;
}

function checklist(page: Page) {
  return page.getByRole('region', { name: 'Getting started', exact: true });
}

function step(page: Page, id: string) {
  return checklist(page).locator(`[data-testid="getting-started-step"][data-step="${id}"]`);
}

/** On the Overview: each step's done state, as the card shows it. */
async function expectSteps(page: Page, done: Record<string, boolean>) {
  for (const [id, isDone] of Object.entries(done)) {
    await expect(step(page, id), `step ${id}`).toHaveAttribute('data-done', String(isDone));
  }
}

/** Sets up the repository from a template on the setup page (leader). */
async function setUpFromTemplate(page: Page, templateName: string) {
  await projectNav(page, 'Files').click();
  await expect(
    page.getByRole('heading', { name: 'Set up the repository', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: templateName, exact: true }).check();
  await page.getByRole('button', { name: 'Set up repository', exact: true }).click();
}

test('a new user starts from the HTML template and follows the checklist to a first submission', async ({
  page,
  context,
}) => {
  acceptDialogs(page);
  const lp: LeaderProject = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);

  // The checklist shows on the Overview from the start.
  await expect(checklist(page)).toBeVisible();
  await expectSteps(page, { setup: false, openIde: false, submit: false });

  // Set up from the HTML/CSS/JS template: main's first commit holds exactly its files.
  await setUpFromTemplate(page, 'HTML/CSS/JS website');
  await expect(
    page.getByRole('main').getByRole('link', { name: 'index.html', exact: true }),
  ).toBeVisible();
  const main = bareGit(projectId, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  expect(bareGit(projectId, ['show', '-s', '--format=%s', main])).toBe(
    'Start from the HTML/CSS/JS website template',
  );
  expect(bareGit(projectId, ['show', '-s', '--format=%an', main])).toBe(lp.leader.name);
  expect(bareGit(projectId, ['ls-tree', '-r', '--name-only', main]).split('\n').sort()).toEqual(
    templateFiles('html'),
  );

  await projectNav(page, 'Overview').click();
  await expectSteps(page, {
    setup: true,
    invite: false,
    openIde: false,
    change: false,
    preview: false,
    submit: false,
    reviewed: false,
  });

  // Open the IDE.
  await page.getByRole('link', { name: 'Open IDE', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `${lp.projectPath}/ide`);
  const frameTitle = `VS Code for ${lp.projectName}`;
  await expect(page.getByTitle(frameTitle, { exact: true })).toBeVisible({ timeout: 120_000 });
  const copy = await getCopy(page, projectId);
  expect(copy?.containerStatus).toBe('running');
  const copyId = copy!.id;
  started.push(copyId);
  const ide = page.frameLocator(`iframe[title="${frameTitle}"]`);
  await expect(
    ide.locator('.explorer-folders-view').getByText('index.html', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  // Change index.html in the copy, as the member would in the editor.
  const folder = copyFolder(projectId, copyId);
  const marker = `Changed in my first DevSpace project ${Date.now()}`;
  const original = readFileSync(join(folder, 'index.html'), 'utf8');
  expect(original).toContain('</body>');
  const changed = original.replace('</body>', `  <p id="e2e-marker">${marker}</p>\n</body>`);
  writeInCopy(folder, 'index.html', changed);

  // Start the app in the IDE's terminal, as the README says: `npm start` (port 8080).
  await ide.locator('.monaco-workbench').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Control+Backquote');
  const terminal = ide.locator('.xterm').first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    // Typed again only if nothing answers yet (the terminal may not have had focus).
    if (!appAnswers(copyId, 8080)) {
      await terminal.click();
      await page.keyboard.type('npm start\n', { delay: 10 });
    }
    await expect.poll(() => appAnswers(copyId, 8080), { timeout: 10_000 }).toBe(true);
  }).toPass({ timeout: 60_000 });

  // Preview: the port defaults to the template's (8080) and opens in a new tab.
  await expect(page.getByLabel('Port', { exact: true })).toHaveValue('8080');
  const newTab = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = await newTab;
  const assets: Response[] = [];
  preview.on('response', (res) => {
    if (/\.(css|js)(\?|$)/.test(new URL(res.url()).pathname)) assets.push(res);
  });
  // The tab opens on about:blank first, then goes to the launch URL, which redirects.
  await expect(preview).toHaveURL(
    (url) => url.origin === IDE_ORIGIN && url.pathname === `/ide/${copyId}/__preview/8080/`,
    { timeout: 30_000 },
  );
  await preview.waitForLoadState('load');
  await expect(preview.locator('#e2e-marker')).toHaveText(marker);
  // Its stylesheet and script load through the same preview path.
  await expect.poll(() => assets.length).toBeGreaterThanOrEqual(2);
  for (const res of assets) {
    expect(res.url(), 'asset under the preview path').toContain(`/ide/${copyId}/__preview/8080/`);
    expect(res.status(), res.url()).toBe(200);
  }
  await preview.close();

  // Submit work from the IDE page.
  await page.getByRole('link', { name: 'Submit work', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `${lp.projectPath}/submissions/new`);
  await expect(page.getByRole('checkbox', { name: 'index.html', exact: true })).toBeChecked();
  const title = `My first change ${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
  await expect(page).toHaveURL(
    (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
  );
  const submissionId = reviewPath.exec(new URL(page.url()).pathname)![1]!;

  // The snapshot in git: the changed index.html on top of the template's commit.
  const ref = `refs/submissions/${submissionId}/v1`;
  expect(bareGit(projectId, ['rev-parse', `${ref}^`])).toBe(main);
  expect(bareGit(projectId, ['show', '-s', '--format=%an', ref])).toBe(lp.leader.name);
  expect(`${bareGit(projectId, ['show', `${ref}:index.html`])}\n`).toBe(
    changed.endsWith('\n') ? changed : `${changed}\n`,
  );
  expect(bareGit(projectId, ['diff', '--name-only', main, ref])).toBe('index.html');
  expect(bareGit(projectId, ['rev-parse', 'refs/heads/main'])).toBe(main);

  // The checklist ticked what was really done; inviting and a review are still to come.
  await page.goto(lp.projectPath);
  await expectSteps(page, {
    setup: true,
    invite: false,
    openIde: true,
    change: true,
    preview: true,
    submit: true,
    reviewed: false,
  });
  const view = await page.request.get(`/api/projects/${projectId}/getting-started`);
  expect(view.status()).toBe(200);
  expect(await view.json()).toEqual({
    hidden: false,
    steps: [
      { id: 'setup', done: true },
      { id: 'invite', done: false },
      { id: 'openIde', done: true },
      { id: 'change', done: true },
      { id: 'preview', done: true },
      { id: 'submit', done: true },
      { id: 'reviewed', done: false },
    ],
  });

  // Hide and show again.
  await checklist(page).getByRole('button', { name: 'Hide getting started', exact: true }).click();
  await expect(checklist(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show getting started', exact: true }).click();
  await expect(checklist(page)).toBeVisible();
});

test('a React + Vite app previews through the preview path, with its module scripts and live reload', async ({
  page,
}) => {
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpFromTemplate(page, 'React + Vite');
  await expect(
    page.getByRole('main').getByRole('link', { name: 'package.json', exact: true }),
  ).toBeVisible();

  // Start the IDE through the API (the first test covers the page) and run the app in it.
  const made = await page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
  expect([200, 201]).toContain(made.status());
  const copyId = (await made.json()).copy.id as string;
  started.push(copyId);
  expect(
    (await page.request.post(`/api/projects/${projectId}/copy/ide`, { data: {} })).status(),
  ).toBe(200);
  await expect
    .poll(async () => (await getCopy(page, projectId))?.containerStatus, { timeout: 120_000 })
    .toBe('running');
  inContainer(copyId, 'timeout 300 npm install --no-audit --no-fund >/tmp/install.log 2>&1');
  inContainer(copyId, 'exec npm run dev >/tmp/app.log 2>&1', true);
  await expect.poll(() => appAnswers(copyId, 5173), { timeout: 60_000 }).toBe(true);

  // Launch the preview in this browser, as the Preview button does.
  const launch = await page.request.post(`/api/projects/${projectId}/copy/preview/launch`, {
    data: { port: 5173 },
  });
  expect(launch.status()).toBe(200);
  const { url } = (await launch.json()) as { url: string };
  expect(url).toMatch(
    new RegExp(
      `^${IDE_ORIGIN.replace(/\./g, '\\.')}/ide-launch\\?ticket=[^&]+&next=__preview(/|%2F)5173(/|%2F)$`,
    ),
  );

  const base = `/ide/${copyId}/__preview/5173/`;
  const scripts: Response[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() === 'script') scripts.push(res);
  });
  const sockets: { url: string; received: string[] }[] = [];
  page.on('websocket', (ws) => {
    const info = { url: ws.url(), received: [] as string[] };
    sockets.push(info);
    ws.on('framereceived', (frame) => info.received.push(String(frame.payload)));
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(url);
  await expect(page).toHaveURL((u) => u.origin === IDE_ORIGIN && u.pathname === base);
  // React rendered into #root: the module scripts ran.
  await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 });
  const entry = scripts.find((res) => /\/src\/main\.jsx(\?|$)/.test(res.url()));
  expect(entry, 'the app entry module script loaded').toBeTruthy();
  expect(entry!.url()).toContain(base);
  expect(entry!.status()).toBe(200);
  expect(entry!.headers()['content-type']).toMatch(/javascript/);
  expect(
    scripts.some((res) => res.url().includes(`${base}@vite/client`) && res.status() === 200),
  ).toBe(true);
  // Vite's live-reload WebSocket connects through the preview path.
  await expect
    .poll(() =>
      sockets.some(
        (s) =>
          s.url.startsWith(`${IDE_ORIGIN.replace(/^http/, 'ws')}${base}`) &&
          s.received.some((m) => m.includes('"connected"')),
      ),
    )
    .toBe(true);

  // Live reload: a change to App.jsx in the copy shows up without reloading the page.
  await page.evaluate(() => ((window as unknown as { e2eSamePage: boolean }).e2eSamePage = true));
  const folder = copyFolder(projectId, copyId);
  const app = readFileSync(join(folder, 'src/App.jsx'), 'utf8');
  const marker = `Live from the copy ${Date.now()}`;
  const withMarker = app.replace(/<h1>[^<]*<\/h1>/, `<h1 id="e2e-live">${marker}</h1>`);
  expect(withMarker, 'App.jsx has an <h1> to change').not.toBe(app);
  writeInCopy(folder, 'src/App.jsx', withMarker);
  await expect(page.locator('#e2e-live')).toHaveText(marker, { timeout: 30_000 });
  expect(
    await page.evaluate(() => (window as unknown as { e2eSamePage?: boolean }).e2eSamePage),
  ).toBe(true);
  expect(errors).toEqual([]);
});
