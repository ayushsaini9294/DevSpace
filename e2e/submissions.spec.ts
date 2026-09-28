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
  projectIdFrom,
  projectNav,
  setUpEmptyRepository,
  writeInCopy,
} from './helpers';

// Phase 6 Done-when: a member submits selected files; a reviewer comments and approves. The test
// checks the snapshot commit in the project's bare repository, not just the status in the app.

test.describe.configure({ timeout: 180_000 });

/** A second file on main, so the member can change two files that exist in base. */
const APP_PATH = 'src/app.txt';
const APP_BASE = 'line one\nline two\nline three\n';
const APP_NEW = 'line one\nline two, changed by the member\nline three\n';
const README_PATH = 'README.md';
const NEW_PATH = 'notes/new.txt';
const NEW_CONTENT = 'a brand new file\n';

/** Sorts file entries by path, by code point (not locale), to compare lists. */
function byPath(a: { path: string }, b: { path: string }) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function status(page: Page) {
  return page.getByTestId('submission-status');
}

/** One file's section on the review page. */
function fileRegion(page: Page, path: string) {
  return page.getByRole('region', { name: path, exact: true });
}

test('a member submits two of three changed files; a reviewer comments on a line and approves', async ({
  page,
  browser,
}) => {
  // Leader: project with an empty repository, plus a second file on main.
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  const main = addFileToMain(projectId, APP_PATH, APP_BASE);
  const readmeBase = bareGit(projectId, ['show', `${main}:${README_PATH}`]);

  // Two members: the author, and a reviewer given Comment and Approve by the leader.
  const author = await addMember(page, browser, lp);
  const reviewer = await addMember(page, browser, lp);
  try {
    await page.goto(lp.projectPath);
    await projectNav(page, 'Members').click();
    await expect(page).toHaveURL(/\/members$/);
    await grantPermission(page, reviewer.user, 'Comment');
    await grantPermission(page, reviewer.user, 'Approve submissions');

    // The author makes their copy (no IDE needed) and edits it on disk, as the IDE would.
    const made = await author.page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
    expect([200, 201]).toContain(made.status());
    const copyId = (await made.json()).copy.id as string;
    const folder = copyFolder(projectId, copyId);
    expect(readFileSync(join(folder, APP_PATH), 'utf8')).toBe(APP_BASE);

    const readmeNew = `${readmeBase}\nEdited by the member, but not submitted.\n`;
    writeInCopy(folder, APP_PATH, APP_NEW);
    writeInCopy(folder, README_PATH, readmeNew);
    writeInCopy(folder, NEW_PATH, NEW_CONTENT);

    // The API sees the three changes against the copy's base.
    const changes = await author.page.request.get(`/api/projects/${projectId}/copy/changes`);
    expect(changes.status()).toBe(200);
    const changed = (await changes.json()) as {
      baseSha: string;
      files: { path: string; change: string; openSubmissionId: string | null }[];
    };
    expect(changed.baseSha).toBe(main);
    expect(changed.files.map(({ path, change }) => ({ path, change })).sort(byPath)).toEqual([
      { path: README_PATH, change: 'modified' },
      { path: NEW_PATH, change: 'added' },
      { path: APP_PATH, change: 'modified' },
    ]);

    // The author submits two of the three through the UI.
    const title = `Change app and add notes ${Date.now()}`;
    await author.page.goto(lp.projectPath);
    await projectNav(author.page, 'Submissions').click();
    await expect(author.page).toHaveURL((url) => url.pathname === `${lp.projectPath}/submissions`);
    await author.page.getByRole('link', { name: 'Submit work', exact: true }).click();
    await expect(author.page).toHaveURL(
      (url) => url.pathname === `${lp.projectPath}/submissions/new`,
    );
    for (const path of [APP_PATH, README_PATH, NEW_PATH]) {
      await expect(author.page.getByRole('checkbox', { name: path, exact: true })).toBeChecked();
    }
    await author.page.getByRole('checkbox', { name: README_PATH, exact: true }).uncheck();
    await author.page.getByLabel('Title', { exact: true }).fill(title);
    await author.page
      .getByLabel('Description', { exact: true })
      .fill('Changes line two and adds a note.');
    await author.page.getByRole('button', { name: 'Submit', exact: true }).click();

    const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
    // Wait until it has left /submissions/new for the new submission's page.
    await expect(author.page).toHaveURL(
      (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
    );
    const submissionId = reviewPath.exec(new URL(author.page.url()).pathname)![1]!;
    await expect(status(author.page)).toHaveText('Open');
    await expect(
      author.page.getByRole('main').getByText(title, { exact: true }).first(),
    ).toBeVisible();

    // The author sees no Approve button, and the API refuses a self-approval.
    await expect(fileRegion(author.page, APP_PATH)).toBeVisible();
    await expect(author.page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    const selfApprove = await author.page.request.post(
      `/api/projects/${projectId}/submissions/${submissionId}/reviews`,
      { data: { decision: 'approved' } },
    );
    expect(selfApprove.status()).toBe(403);
    expect((await selfApprove.json()).error).toBe('own_submission');

    // The reviewer opens the submission, sees the diff, comments on line 2 of src/app.txt.
    const reviewUrl = `${lp.projectPath}/submissions/${submissionId}`;
    await reviewer.page.goto(reviewUrl);
    await expect(status(reviewer.page)).toHaveText('Open');
    const appFile = fileRegion(reviewer.page, APP_PATH);
    // The head side's own lines (not the view zones that show removed lines inline).
    await expect(appFile.locator('.editor.modified .lines-content > .view-lines')).toContainText(
      'line two, changed by the member',
    );
    await expect(fileRegion(reviewer.page, NEW_PATH)).toBeVisible();
    await expect(fileRegion(reviewer.page, README_PATH)).toHaveCount(0);

    const commentBody = `Nice wording on this line ${Date.now()}`;
    await appFile.getByRole('button', { name: 'Comment on a line', exact: true }).click();
    await appFile.getByLabel('Line', { exact: true }).fill('2');
    await appFile.getByLabel('Comment', { exact: true }).fill(commentBody);
    await appFile.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect(
      appFile.getByTestId('comment-thread').filter({ hasText: commentBody }),
    ).toBeVisible();

    // …and approves.
    await reviewer.page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = reviewer.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Approve submission', exact: true }).click();
    await expect(status(reviewer.page)).toHaveText('Approved');

    // The author sees it approved, with the reviewer's comment on the line.
    await author.page.reload();
    await expect(status(author.page)).toHaveText('Approved');
    await expect(
      fileRegion(author.page, APP_PATH)
        .getByTestId('comment-thread')
        .filter({ hasText: commentBody }),
    ).toBeVisible();

    // The API agrees: two files, the line comment, one approval.
    const detailRes = await reviewer.page.request.get(
      `/api/projects/${projectId}/submissions/${submissionId}`,
    );
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()).submission;
    expect(detail.status).toBe('approved');
    expect(detail.version).toBe(1);
    expect(detail.baseSha).toBe(main);
    expect(
      (detail.files as { path: string; change: string }[])
        .map(({ path, change }) => ({ path, change }))
        .sort(byPath),
    ).toEqual([
      { path: NEW_PATH, change: 'added' },
      { path: APP_PATH, change: 'modified' },
    ]);
    expect(detail.comments).toEqual([
      expect.objectContaining({
        body: commentBody,
        path: APP_PATH,
        side: 'head',
        line: 2,
        outdated: false,
      }),
    ]);

    // The real result, in git: refs/submissions/<id>/v1 in the project's bare repository.
    const ref = `refs/submissions/${submissionId}/v1`;
    const head = bareGit(projectId, ['rev-parse', '--verify', `${ref}^{commit}`]);
    expect(head).toBe(detail.headSha);
    expect(bareGit(projectId, ['rev-parse', `${ref}^`])).toBe(main);
    expect(bareGit(projectId, ['show', '-s', '--format=%s', ref])).toBe(title);
    expect(bareGit(projectId, ['show', '-s', '--format=%an', ref])).toBe(author.user.name);
    expect(`${bareGit(projectId, ['show', `${ref}:${APP_PATH}`])}\n`).toBe(APP_NEW);
    expect(`${bareGit(projectId, ['show', `${ref}:${NEW_PATH}`])}\n`).toBe(NEW_CONTENT);
    // The unticked file is exactly as in base (same blob), though it changed in the copy.
    expect(bareGit(projectId, ['rev-parse', `${ref}:${README_PATH}`])).toBe(
      bareGit(projectId, ['rev-parse', `${main}:${README_PATH}`]),
    );
    expect(bareGit(projectId, ['diff', '--name-only', main, ref]).split('\n').sort()).toEqual(
      [NEW_PATH, APP_PATH].sort(),
    );

    // main is unchanged, and the copy still holds all three edits.
    expect(bareGit(projectId, ['rev-parse', 'refs/heads/main'])).toBe(main);
    expect(bareGit(projectId, ['ls-tree', '-r', '--name-only', 'refs/heads/main'])).not.toContain(
      NEW_PATH,
    );
    expect(readFileSync(join(folder, README_PATH), 'utf8')).toBe(readmeNew);
    expect(readFileSync(join(folder, APP_PATH), 'utf8')).toBe(APP_NEW);
    expect(readFileSync(join(folder, NEW_PATH), 'utf8')).toBe(NEW_CONTENT);
  } finally {
    await author.page.context().close();
    await reviewer.page.context().close();
  }
});
