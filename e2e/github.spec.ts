import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  acceptDialogs,
  addFileToMain,
  addMember,
  bareGit,
  copyFolder,
  createLeaderWithProject,
  type LeaderProject,
  projectIdFrom,
  setUpEmptyRepository,
  uniqueId,
  writeInCopy,
} from './helpers';

// Phase 13 Done-when: the project appears on GitHub and updates after a merge. "GitHub" here is the
// stand-in (a test double, e2e/stubs/github.ts) that playwright.config.ts starts; every check reads
// the stand-in's real git repository (its main and history) and compares it with DevSpace's main
// in the project's bare repository.

test.describe.configure({ timeout: 240_000 });

const GITHUB = `http://127.0.0.1:${process.env.GITHUB_STUB_PORT || '4020'}`;

/** How long the worker may take to push to GitHub after a merge. */
const SYNC_TIMEOUT = 60_000;

const APP_PATH = 'src/app.txt';

type StandInRepo = {
  exists: boolean;
  private: boolean;
  full_name: string;
  html_url: string;
  main: string | null;
  log: string[];
  refs: string[];
  pushes: {
    installationId: number;
    refs: { old: string; new: string; ref: string; fastForward: boolean | null }[];
  }[];
};

async function standInRepo(page: Page, fullName: string): Promise<StandInRepo> {
  const res = await page.request.get(`${GITHUB}/__stub/repos/${fullName}`);
  return (await res.json()) as StandInRepo;
}

function mainSha(projectId: string) {
  return bareGit(projectId, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
}

/** DevSpace main's full history, newest first (what `git rev-list main` prints). */
function mainHistory(projectId: string) {
  return bareGit(projectId, ['rev-list', 'refs/heads/main']).split('\n');
}

function githubStatus(page: Page) {
  return page.getByTestId('github-section').getByTestId('github-status');
}

/** Settings → GitHub: connect through the stand-in's authorize page and install the app. */
async function connectGithub(page: Page) {
  await page.goto('/settings/github');
  await expect(page.getByTestId('github-connection-status')).toHaveText('Not connected');
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

  // The stand-in's authorize page (a test double): a GitHub username and one button.
  await expect(page).toHaveURL((url) => url.origin === GITHUB);
  const login = `octo-${uniqueId()}`.slice(0, 39);
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Authorize DevSpace', exact: true }).click();

  await expect(page).toHaveURL((url) => url.pathname === '/settings/github');
  await expect(page.getByText('GitHub connected.')).toBeVisible();
  await expect(page.getByTestId('github-connection-status')).toHaveText('Connected');
  await expect(page.getByTestId('github-login')).toHaveText(login);

  // Install the DevSpace app on that account (the link leads to the stand-in's install page).
  const installUrl = await page.getByTestId('github-install-link').getAttribute('href');
  expect(installUrl).toBe(`${GITHUB}/apps/devspace-stand-in/installations/new`);
  await page.goto(installUrl!);
  await expect(page.getByLabel('Account')).toHaveValue(login);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Installed' })).toBeVisible();
  return login;
}

/**
 * Project Settings → GitHub: publishes main as a new private repository, in "keep updated" mode,
 * after ticking the email warning (main has a commit with a real email from the test setup).
 */
async function publish(page: Page, lp: LeaderProject) {
  await page.goto(`${lp.projectPath}/settings`);
  const section = page.getByTestId('github-section');
  const name = `devspace-e2e-${uniqueId()}`;
  const nameBox = section.getByLabel('Repository name', { exact: true });
  await expect(nameBox).not.toHaveValue('');
  await nameBox.fill(name);
  await expect(section.getByRole('checkbox', { name: 'Make it public' })).not.toBeChecked();
  await section.getByRole('radio', { name: 'Keep updated', exact: true }).check();

  // The setup commit (addFileToMain) has a real email; the warning names the person, not the email.
  const warning = section.getByTestId('github-email-warning');
  await expect(warning).toContainText('E2E setup');
  await expect(warning).not.toContainText('e2e@example.com');
  const publishButton = section.getByRole('button', { name: 'Publish to GitHub', exact: true });
  await warning
    .getByRole('checkbox', { name: 'I understand these addresses will be public on GitHub' })
    .check();
  await publishButton.click();
  return name;
}

/** A member changes APP_PATH in their copy and submits; the leader approves and merges. */
async function memberChangeMerged(page: Page, browser: Browser, lp: LeaderProject, text: string) {
  const projectId = projectIdFrom(lp.projectPath);
  const member = await addMember(page, browser, lp);
  try {
    const res = await member.page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
    expect([200, 201]).toContain(res.status());
    const folder = copyFolder(projectId, (await res.json()).copy.id as string);
    writeInCopy(folder, APP_PATH, text);

    await member.page.goto(`${lp.projectPath}/submissions/new`);
    await expect(member.page.getByRole('checkbox', { name: APP_PATH, exact: true })).toBeChecked();
    await member.page.getByLabel('Title', { exact: true }).fill(`Change the app ${uniqueId()}`);
    await member.page.getByRole('button', { name: 'Submit', exact: true }).click();
    const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
    await expect(member.page).toHaveURL(
      (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
    );
    const reviewUrl = new URL(member.page.url()).pathname;

    await page.goto(reviewUrl);
    const status = page.getByTestId('submission-status');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Approve submission', exact: true })
      .click();
    await expect(status).toHaveText('Approved');
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Merge into main', exact: true })
      .click();
    await expect(status).toHaveText('Merged');
  } finally {
    await member.page.context().close();
  }
  return mainSha(projectId);
}

/** No push to the stand-in ever replaced history or touched anything but main. */
function expectNoForce(repo: StandInRepo) {
  const updates = repo.pushes.flatMap((p) => p.refs);
  expect(updates.length).toBeGreaterThan(0);
  for (const update of updates) {
    expect(update.ref).toBe('refs/heads/main');
    expect(update.fastForward).not.toBe(false);
  }
  expect(repo.refs).toEqual(['refs/heads/main']);
}

/** Leader, project with an empty repository plus one file, GitHub connected and published. */
async function publishedProject(page: Page) {
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  addFileToMain(projectId, APP_PATH, 'line one\nline two\n');

  const login = await connectGithub(page);
  const name = await publish(page, lp);
  const fullName = `${login}/${name}`;

  // Published: the link goes to the new repository, and the push finishes ("Up to date").
  const section = page.getByTestId('github-section');
  await expect(section.getByTestId('github-repo-link')).toHaveAttribute(
    'href',
    `${GITHUB}/${fullName}`,
  );
  await expect(githubStatus(page)).toHaveAttribute('data-status', 'ok', { timeout: SYNC_TIMEOUT });
  return { lp, projectId, login, fullName };
}

test('publishing puts main on GitHub (private, full history) and a merge updates it', async ({
  page,
  browser,
}) => {
  const { lp, projectId, login, fullName } = await publishedProject(page);

  // The stand-in repository is private, on the publisher's account, and its main is DevSpace's
  // main with the full history.
  const published = await standInRepo(page, fullName);
  expect(published.exists).toBe(true);
  expect(published.private).toBe(true);
  expect(published.full_name).toBe(fullName);
  expect(published.main).toBe(mainSha(projectId));
  expect(published.log).toEqual(mainHistory(projectId));
  expect(published.log.length).toBeGreaterThanOrEqual(2);
  expectNoForce(published);

  // A member's submission is merged: the worker pushes the new main to GitHub.
  const merged = await memberChangeMerged(page, browser, lp, 'line one\nline two, merged\n');
  await expect
    .poll(async () => (await standInRepo(page, fullName)).main, {
      timeout: SYNC_TIMEOUT,
      intervals: [250, 500, 1000],
    })
    .toBe(merged);
  const updated = await standInRepo(page, fullName);
  expect(updated.log).toEqual(mainHistory(projectId));
  expectNoForce(updated);

  // Commits DevSpace makes use private emails: the leader connected GitHub, so the merge's
  // committer is their GitHub noreply address.
  expect(bareGit(projectId, ['show', '-s', '--format=%ce', merged])).toMatch(
    new RegExp(`^\\d+\\+${login}@users\\.noreply\\.github\\.com$`),
  );

  await page.goto(`${lp.projectPath}/settings`);
  await expect(githubStatus(page)).toHaveAttribute('data-status', 'ok');
});

test('when GitHub has changes made outside DevSpace, the next merge pauses and never overwrites them', async ({
  page,
  browser,
}) => {
  const { lp, projectId, fullName } = await publishedProject(page);

  // Someone changes the repository directly on GitHub.
  const res = await page.request.post(`${GITHUB}/__stub/repos/${fullName}/commit`, {
    data: { path: 'NOTES.md', content: 'Edited on GitHub\n', message: 'Edit on GitHub' },
  });
  expect(res.status()).toBe(201);
  const before = await standInRepo(page, fullName);
  expect(before.main).toBe(((await res.json()) as { sha: string }).sha);

  // A merge in DevSpace: the push is refused as non-fast-forward, so syncing pauses.
  const merged = await memberChangeMerged(page, browser, lp, 'line one\nline two, paused\n');
  expect(merged).not.toBe(before.main);
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/projects/${projectId}/github`)).json()) as {
            link: { status: string } | null;
          }
        ).link?.status,
      { timeout: SYNC_TIMEOUT, intervals: [250, 500, 1000] },
    )
    .toBe('paused');
  await page.goto(`${lp.projectPath}/settings`);
  await expect(githubStatus(page)).toHaveAttribute('data-status', 'paused');
  await expect(githubStatus(page)).toContainText('Paused');
  await expect(page.getByTestId('github-status-reason')).toContainText(
    'GitHub has changes made outside DevSpace',
  );

  // GitHub's history is exactly as it was: nothing overwritten, never a forced update.
  const after = await standInRepo(page, fullName);
  expect(after.main).toBe(before.main);
  expect(after.log).toEqual(before.log);
  expectNoForce(after);

  // "Try again" still pauses, and still leaves GitHub alone.
  await page
    .getByTestId('github-section')
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await expect(githubStatus(page)).toHaveAttribute('data-status', 'paused', {
    timeout: SYNC_TIMEOUT,
  });
  const retried = await standInRepo(page, fullName);
  expect(retried.main).toBe(before.main);
  expect(retried.log).toEqual(before.log);
  expectNoForce(retried);
  expect(mainSha(projectId)).toBe(merged);
});
