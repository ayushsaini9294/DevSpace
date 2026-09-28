import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  acceptDialogs,
  addFileToMain,
  addMember,
  bareGit,
  copyFolder,
  createLeaderWithProject,
  grantPermission,
  type LeaderProject,
  projectIdFrom,
  projectNav,
  setUpEmptyRepository,
  writeInCopy,
} from './helpers';

// Phase 7 Done-when: after a merge the file in main really changes; revert restores it. Every check
// reads the files themselves: main in the project's bare repository (git runs only there, never in
// a copy) and the members' copy folders on disk.

test.describe.configure({ timeout: 180_000 });

const APP_PATH = 'src/app.txt';
const APP_BASE = 'line one\nline two\nline three\n';

/** How long the worker may take to update a copy after main moves (automatic mode). */
const WORKER_TIMEOUT = 60_000;

type Changes = {
  baseSha: string;
  files: { path: string; change: string; openSubmissionId: string | null }[];
};

function mainSha(projectId: string) {
  return bareGit(projectId, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
}

/** A file on main (or any commit), with the trailing newline that bareGit strips. */
function showFile(projectId: string, rev: string, path: string) {
  return `${bareGit(projectId, ['show', `${rev}:${path}`])}\n`;
}

function readCopyFile(folder: string, path: string) {
  return readFileSync(join(folder, path), 'utf8');
}

function status(page: Page) {
  return page.getByTestId('submission-status');
}

/** Makes the member's copy (no IDE needed) and returns its folder on disk. */
async function makeCopy(page: Page, projectId: string) {
  const res = await page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
  expect([200, 201]).toContain(res.status());
  const copyId = (await res.json()).copy.id as string;
  return copyFolder(projectId, copyId);
}

async function copyChanges(page: Page, projectId: string): Promise<Changes> {
  const res = await page.request.get(`/api/projects/${projectId}/copy/changes`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Changes;
}

/**
 * Waits until the member's copy has been moved onto `sha` (the worker's automatic update sets the
 * copy's base only after it has written the files).
 */
async function waitForCopyBase(page: Page, projectId: string, sha: string) {
  await expect
    .poll(async () => (await copyChanges(page, projectId)).baseSha, {
      timeout: WORKER_TIMEOUT,
      intervals: [250, 500, 1000],
    })
    .toBe(sha);
}

/** The author submits every changed file through the UI; returns the submission id. */
async function submitAll(page: Page, lp: LeaderProject, title: string) {
  await page.goto(`${lp.projectPath}/submissions/new`);
  await expect(page.getByRole('checkbox', { name: APP_PATH, exact: true })).toBeChecked();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
  await expect(page).toHaveURL(
    (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
  );
  await expect(status(page)).toHaveText('Open');
  return reviewPath.exec(new URL(page.url()).pathname)![1]!;
}

async function approve(page: Page, reviewUrl: string) {
  await page.goto(reviewUrl);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(status(page)).toHaveText('Approved');
}

/** The leader merges from the review page (already open) and waits for Merged. */
async function merge(page: Page) {
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Merge into main', exact: true })
    .click();
  await expect(status(page)).toHaveText('Merged');
}

test('a merge changes main and updates other copies; undo restores main and gives the author their change back', async ({
  page,
  browser,
}) => {
  // Leader: project with an empty repository, plus src/app.txt on main.
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  const main0 = addFileToMain(projectId, APP_PATH, APP_BASE);

  // The author, and a second member with Approve who also has a copy.
  const author = await addMember(page, browser, lp);
  const other = await addMember(page, browser, lp);
  try {
    // Reload the project so the Members page lists both new members.
    await page.goto(lp.projectPath);
    await projectNav(page, 'Members').click();
    await expect(page).toHaveURL(/\/members$/);
    await grantPermission(page, other.user, 'Approve submissions');

    const authorFolder = await makeCopy(author.page, projectId);
    const otherFolder = await makeCopy(other.page, projectId);
    expect(readCopyFile(otherFolder, APP_PATH)).toBe(APP_BASE);

    // The author changes a line in their copy and submits it; the other member approves.
    const appNew = `line one\nline two, merged ${Date.now()}\nline three\n`;
    writeInCopy(authorFolder, APP_PATH, appNew);
    const title = `Change line two ${Date.now()}`;
    const submissionId = await submitAll(author.page, lp, title);
    const reviewUrl = `${lp.projectPath}/submissions/${submissionId}`;
    await approve(other.page, reviewUrl);

    // The leader merges.
    await page.goto(reviewUrl);
    await expect(status(page)).toHaveText('Approved');
    await merge(page);
    await expect(
      page.getByRole('main').getByText(`Merged by ${lp.leader.name} into main`),
    ).toBeVisible();

    // main really changed: exactly one new commit on top of the old main, credited to the author,
    // committed by the leader, holding the new text.
    const main1 = mainSha(projectId);
    expect(main1).not.toBe(main0);
    expect(bareGit(projectId, ['rev-list', '--count', `${main0}..${main1}`])).toBe('1');
    expect(bareGit(projectId, ['rev-parse', `${main1}^`])).toBe(main0);
    expect(bareGit(projectId, ['show', '-s', '--format=%an <%ae>', main1])).toBe(
      `${author.user.name} <${author.user.email}>`,
    );
    expect(bareGit(projectId, ['show', '-s', '--format=%cn <%ce>', main1])).toBe(
      `${lp.leader.name} <${lp.leader.email}>`,
    );
    const message = bareGit(projectId, ['show', '-s', '--format=%B', main1]);
    expect(message.split('\n')[0]).toBe(title);
    expect(message).toContain(`Submission: ${submissionId}`);
    expect(showFile(projectId, main1, APP_PATH)).toBe(appNew);
    expect(bareGit(projectId, ['diff', '--name-only', main0, main1])).toBe(APP_PATH);

    const merged = (
      await (
        await page.request.get(`/api/projects/${projectId}/submissions/${submissionId}`)
      ).json()
    ).submission;
    expect(merged.status).toBe('merged');
    expect(merged.mergedSha).toBe(main1);

    // Automatic mode: the worker updates the other member's copy on disk…
    await waitForCopyBase(other.page, projectId, main1);
    expect(readCopyFile(otherFolder, APP_PATH)).toBe(appNew);
    expect((await copyChanges(other.page, projectId)).files).toEqual([]);
    // …and the author's (their change is now in main, so nothing is left to submit).
    await waitForCopyBase(author.page, projectId, main1);
    expect(readCopyFile(authorFolder, APP_PATH)).toBe(appNew);
    expect((await copyChanges(author.page, projectId)).files).toEqual([]);

    // The leader undoes the merge.
    await page.getByRole('button', { name: 'Undo merge', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Undo merge', exact: true }).click();
    await expect(status(page)).toHaveText('Reverted');

    // main's file is back to the original, with one new revert commit on top.
    const main2 = mainSha(projectId);
    expect(bareGit(projectId, ['rev-parse', `${main2}^`])).toBe(main1);
    expect(showFile(projectId, main2, APP_PATH)).toBe(APP_BASE);
    expect(bareGit(projectId, ['rev-parse', `${main2}^{tree}`])).toBe(
      bareGit(projectId, ['rev-parse', `${main0}^{tree}`]),
    );
    expect(bareGit(projectId, ['show', '-s', '--format=%s', main2])).toBe(`Revert "${title}"`);
    expect(bareGit(projectId, ['show', '-s', '--format=%an', main2])).toBe(lp.leader.name);

    const reverted = (
      await (
        await page.request.get(`/api/projects/${projectId}/submissions/${submissionId}`)
      ).json()
    ).submission;
    expect(reverted.status).toBe('reverted');
    expect(reverted.revertedSha).toBe(main2);

    // The author keeps the change in their copy, and it shows up again as a changed file.
    await waitForCopyBase(author.page, projectId, main2);
    expect(readCopyFile(authorFolder, APP_PATH)).toBe(appNew);
    const authorChanges = await copyChanges(author.page, projectId);
    expect(authorChanges.files.map(({ path, change }) => ({ path, change }))).toEqual([
      { path: APP_PATH, change: 'modified' },
    ]);

    // Everyone else gets the undo normally.
    await waitForCopyBase(other.page, projectId, main2);
    expect(readCopyFile(otherFolder, APP_PATH)).toBe(APP_BASE);
  } finally {
    await author.page.context().close();
    await other.page.context().close();
  }
});

test('a conflicting submission needs an update; the author updates their copy, resolves the markers and it merges', async ({
  page,
  browser,
}) => {
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  const main0 = addFileToMain(projectId, APP_PATH, APP_BASE);

  // Two members edit the same line in their own copies. The leader reviews both.
  const first = await addMember(page, browser, lp);
  const second = await addMember(page, browser, lp);
  try {
    const firstFolder = await makeCopy(first.page, projectId);
    const secondFolder = await makeCopy(second.page, projectId);
    const firstText = 'line one\nline two, as the first member wrote it\nline three\n';
    const secondText = 'line one\nline two, as the second member wrote it\nline three\n';
    writeInCopy(firstFolder, APP_PATH, firstText);
    writeInCopy(secondFolder, APP_PATH, secondText);

    const firstId = await submitAll(first.page, lp, `First edit ${Date.now()}`);
    const secondId = await submitAll(second.page, lp, `Second edit ${Date.now()}`);
    const firstUrl = `${lp.projectPath}/submissions/${firstId}`;
    const secondUrl = `${lp.projectPath}/submissions/${secondId}`;

    // The leader approves and merges the first.
    await approve(page, firstUrl);
    await merge(page);
    const main1 = mainSha(projectId);
    expect(bareGit(projectId, ['rev-parse', `${main1}^`])).toBe(main0);
    expect(showFile(projectId, main1, APP_PATH)).toBe(firstText);

    // The second submission now conflicts with main: Needs update, listing the file.
    await second.page.goto(secondUrl);
    await expect(status(second.page)).toHaveText('Needs update');
    await expect(
      second.page.getByRole('region', { name: 'Needs update', exact: true }),
    ).toContainText(APP_PATH);
    // The API refuses to merge it, and main stays as it is.
    const blocked = await page.request.post(
      `/api/projects/${projectId}/submissions/${secondId}/merge`,
      { data: {} },
    );
    expect(blocked.status()).toBe(409);
    expect(mainSha(projectId)).toBe(main1);

    // Automatic mode leaves a conflicting copy untouched and records the files that would clash.
    await expect
      .poll(
        async () =>
          (await (await second.page.request.get(`/api/projects/${projectId}/copy`)).json()).copy
            .pendingConflictPaths,
        { timeout: WORKER_TIMEOUT, intervals: [250, 500, 1000] },
      )
      .toEqual([APP_PATH]);
    expect(readCopyFile(secondFolder, APP_PATH)).toBe(secondText);
    expect((await copyChanges(second.page, projectId)).baseSha).toBe(main0);

    // The second member clicks Update my copy: the file on disk gets conflict markers.
    await second.page.goto(lp.projectPath);
    const banner = second.page.getByRole('region', { name: 'Main has changed', exact: true });
    await banner.getByRole('button', { name: 'Update my copy', exact: true }).click();
    const unresolved = second.page.getByRole('list', {
      name: 'Files with conflict markers',
      exact: true,
    });
    await expect(unresolved.getByRole('listitem')).toHaveText([APP_PATH]);

    const marked = readCopyFile(secondFolder, APP_PATH);
    expect(marked).toMatch(/^<<<<<<< your copy$/m);
    expect(marked).toMatch(/^=======$/m);
    expect(marked).toMatch(/^>>>>>>> main$/m);
    expect(marked).toContain('line two, as the first member wrote it');
    expect(marked).toContain('line two, as the second member wrote it');
    expect((await copyChanges(second.page, projectId)).baseSha).toBe(main1);

    // They resolve it (as they would in the IDE); the markers are gone from the copy's view.
    const resolved = 'line one\nline two, as both members agreed\nline three\n';
    writeInCopy(secondFolder, APP_PATH, resolved);
    await expect
      .poll(
        async () =>
          (await (await second.page.request.get(`/api/projects/${projectId}/copy`)).json()).copy
            .unresolvedPaths,
      )
      .toEqual([]);

    // …and update the submission from the review page.
    await second.page.goto(secondUrl);
    await second.page.getByRole('link', { name: 'Update', exact: true }).click();
    await expect(second.page.getByRole('checkbox', { name: APP_PATH, exact: true })).toBeChecked();
    await second.page.getByRole('button', { name: 'Update submission', exact: true }).click();
    await expect(second.page).toHaveURL((url) => url.pathname === secondUrl);
    await expect(status(second.page)).toHaveText('Open');

    const updated = (
      await (
        await second.page.request.get(`/api/projects/${projectId}/submissions/${secondId}`)
      ).json()
    ).submission;
    expect(updated.version).toBe(2);
    expect(updated.baseSha).toBe(main1);
    expect(updated.conflictPaths).toEqual([]);

    // The leader approves and merges it: main has the resolved text, in one more commit.
    await approve(page, secondUrl);
    await merge(page);
    const main2 = mainSha(projectId);
    expect(bareGit(projectId, ['rev-parse', `${main2}^`])).toBe(main1);
    expect(showFile(projectId, main2, APP_PATH)).toBe(resolved);
    expect(bareGit(projectId, ['show', '-s', '--format=%an', main2])).toBe(second.user.name);
  } finally {
    await first.page.context().close();
    await second.page.context().close();
  }
});
