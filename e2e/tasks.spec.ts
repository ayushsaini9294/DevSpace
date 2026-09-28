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
  uniqueId,
  writeInCopy,
} from './helpers';

// Phase 8 Done-when: a task moves to In review on submit and Done after the leader confirms. Each
// step is checked on the board and in the API, and the merge is checked in main itself.

test.describe.configure({ timeout: 180_000 });

const APP_PATH = 'src/app.txt';
const APP_BASE = 'line one\nline two\nline three\n';

type Column = 'To do' | 'In progress' | 'In review' | 'Done';

type TaskView = {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done';
  assignees: { id: string; name: string }[];
  createdBy: { id: string; name: string };
  doneConfirmPending: boolean;
  linkedSubmissions: { id: string; title: string; status: string }[];
  completedAt: string | null;
  viewerActions: string[];
};

function column(page: Page, name: Column) {
  return page.getByRole('region', { name, exact: true });
}

/** The task's card, wherever it is on the board. */
function card(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title });
}

/**
 * Opens the board and waits until the card is in the given column. The board refetches about every
 * 10 s; reloading makes each check fresh instead of waiting for the next refetch.
 */
async function expectOnBoard(page: Page, lp: LeaderProject, title: string, name: Column) {
  await page.goto(`${lp.projectPath}/tasks`);
  await expect(column(page, name).getByRole('listitem').filter({ hasText: title })).toBeVisible();
  await expect(card(page, title)).toHaveCount(1);
}

async function getTask(page: Page, projectId: string, taskId: string) {
  const res = await page.request.get(`/api/projects/${projectId}/tasks`);
  expect(res.status()).toBe(200);
  const task = ((await res.json()).tasks as TaskView[]).find((t) => t.id === taskId);
  expect(task, `task ${taskId} in GET /tasks`).toBeDefined();
  return task!;
}

function submissionStatus(page: Page) {
  return page.getByTestId('submission-status');
}

test('a task moves to In review when linked work is submitted and to Done after the leader confirms the merge', async ({
  page,
  browser,
}) => {
  // Leader: project with an empty repository, plus src/app.txt on main.
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  const main0 = addFileToMain(projectId, APP_PATH, APP_BASE);

  // The assignee, and a second member with Approve submissions who reviews.
  const member = await addMember(page, browser, lp);
  const reviewer = await addMember(page, browser, lp);
  try {
    await page.goto(lp.projectPath);
    await projectNav(page, 'Members').click();
    await expect(page).toHaveURL(/\/members$/);
    await grantPermission(page, reviewer.user, 'Approve submissions');

    // 1. The leader creates a task assigned to the member.
    const title = `Change line two ${uniqueId()}`;
    await projectNav(page, 'Tasks').click();
    await expect(page).toHaveURL(new RegExp(`${lp.projectPath}/tasks$`));
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await dialog.getByLabel('Title', { exact: true }).fill(title);
    await dialog.getByLabel('Description', { exact: true }).fill('Reword the second line.');
    await dialog.getByRole('checkbox', { name: member.user.name, exact: true }).check();
    const created = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/api/projects/${projectId}/tasks`,
    );
    await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
    const createdRes = await created;
    expect(createdRes.status()).toBe(201);
    const taskId = (await createdRes.json()).task.id as string;
    await expect(dialog).toBeHidden();
    await expect(
      column(page, 'To do').getByRole('listitem').filter({ hasText: title }),
    ).toBeVisible();

    let task = await getTask(page, projectId, taskId);
    expect(task.title).toBe(title);
    expect(task.status).toBe('todo');
    expect(task.assignees.map((a) => a.name)).toEqual([member.user.name]);
    expect(task.createdBy.name).toBe(lp.leader.name);
    expect(task.doneConfirmPending).toBe(false);

    // 2. The member moves it to In progress with the card's status menu.
    await expectOnBoard(member.page, lp, title, 'To do');
    await card(member.page, title)
      .getByRole('button', { name: `Move ${title}`, exact: true })
      .click();
    const menu = member.page.getByRole('menu');
    // An assignee may only move between To do and In progress.
    await expect(menu.getByRole('menuitem')).toHaveText(['In progress']);
    await menu.getByRole('menuitem', { name: 'In progress', exact: true }).click();
    await expect(
      column(member.page, 'In progress').getByRole('listitem').filter({ hasText: title }),
    ).toBeVisible();
    task = await getTask(member.page, projectId, taskId);
    expect(task.status).toBe('in_progress');
    // The API refuses an assignee's move to In review.
    const badMove = await member.page.request.post(
      `/api/projects/${projectId}/tasks/${taskId}/move`,
      { data: { status: 'in_review', position: 0 } },
    );
    expect(badMove.status()).toBe(409);
    expect((await badMove.json()).error).toBe('invalid_move');

    // The member changes a file in their copy and submits it linked to the task.
    const made = await member.page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
    expect([200, 201]).toContain(made.status());
    const folder = copyFolder(projectId, (await made.json()).copy.id as string);
    const appNew = `line one\nline two, done for the task ${Date.now()}\nline three\n`;
    writeInCopy(folder, APP_PATH, appNew);

    await member.page.goto(`${lp.projectPath}/submissions/new`);
    await expect(member.page.getByRole('checkbox', { name: APP_PATH, exact: true })).toBeChecked();
    const subTitle = `Work for ${title}`;
    await member.page.getByLabel('Title', { exact: true }).fill(subTitle);
    await member.page.getByLabel('Task', { exact: true }).selectOption({ label: title });
    await member.page.getByRole('button', { name: 'Submit', exact: true }).click();
    const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
    await expect(member.page).toHaveURL(
      (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
    );
    await expect(submissionStatus(member.page)).toHaveText('Open');
    const submissionId = reviewPath.exec(new URL(member.page.url()).pathname)![1]!;
    const reviewUrl = `${lp.projectPath}/submissions/${submissionId}`;
    await expect(member.page.getByRole('link', { name: title, exact: true })).toBeVisible();

    // → the task is In review, on the board and in the API, linked to the submission.
    await expectOnBoard(member.page, lp, title, 'In review');
    task = await getTask(member.page, projectId, taskId);
    expect(task.status).toBe('in_review');
    expect(task.linkedSubmissions).toEqual([{ id: submissionId, title: subTitle, status: 'open' }]);
    const sub = (
      await (
        await member.page.request.get(`/api/projects/${projectId}/submissions/${submissionId}`)
      ).json()
    ).submission;
    expect(sub.task).toEqual({ id: taskId, title, status: 'in_review' });

    // 3. The reviewer approves; the leader merges.
    await reviewer.page.goto(reviewUrl);
    await reviewer.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await reviewer.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Approve submission', exact: true })
      .click();
    await expect(submissionStatus(reviewer.page)).toHaveText('Approved');
    task = await getTask(page, projectId, taskId);
    expect(task.status).toBe('in_review');

    await page.goto(reviewUrl);
    await expect(submissionStatus(page)).toHaveText('Approved');
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Merge into main', exact: true })
      .click();
    await expect(submissionStatus(page)).toHaveText('Merged');

    // main really changed, in one commit.
    const main1 = bareGit(projectId, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
    expect(bareGit(projectId, ['rev-parse', `${main1}^`])).toBe(main0);
    expect(`${bareGit(projectId, ['show', `${main1}:${APP_PATH}`])}\n`).toBe(appNew);

    // The task waits in In review for the leader's confirmation.
    task = await getTask(page, projectId, taskId);
    expect(task.status).toBe('in_review');
    expect(task.doneConfirmPending).toBe(true);
    expect(task.completedAt).toBeNull();
    expect(task.viewerActions).toContain('confirmDone');

    // The leader sees the prompt on the review page too.
    await expect(page.getByRole('main').getByText('Mark this task done?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not yet', exact: true })).toBeVisible();

    // 4. The member sees no Yes / Not yet: not on the board, not on the review page, and the API
    // refuses them.
    await expectOnBoard(member.page, lp, title, 'In review');
    await expect(member.page.getByText('Mark this task done?')).toHaveCount(0);
    await expect(member.page.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
    await expect(member.page.getByRole('button', { name: 'Not yet', exact: true })).toHaveCount(0);
    await member.page.goto(reviewUrl);
    await expect(submissionStatus(member.page)).toHaveText('Merged');
    await expect(member.page.getByText('Mark this task done?')).toHaveCount(0);
    await expect(member.page.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
    await expect(member.page.getByRole('button', { name: 'Not yet', exact: true })).toHaveCount(0);
    expect((await getTask(member.page, projectId, taskId)).viewerActions).not.toContain(
      'confirmDone',
    );
    const memberConfirm = await member.page.request.post(
      `/api/projects/${projectId}/tasks/${taskId}/confirm-done`,
      { data: { done: true } },
    );
    expect(memberConfirm.status()).toBe(403);
    expect((await getTask(page, projectId, taskId)).status).toBe('in_review');

    // The leader answers Yes on the board's card → Done.
    await expectOnBoard(page, lp, title, 'In review');
    const waiting = card(page, title);
    await expect(waiting.getByText('Mark this task done?')).toBeVisible();
    const confirmed = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/api/projects/${projectId}/tasks/${taskId}/confirm-done`,
    );
    await waiting.getByRole('button', { name: 'Yes', exact: true }).click();
    expect((await confirmed).status()).toBe(200);
    await expect(
      column(page, 'Done').getByRole('listitem').filter({ hasText: title }),
    ).toBeVisible();
    await expect(card(page, title).getByText('Mark this task done?')).toHaveCount(0);

    task = await getTask(page, projectId, taskId);
    expect(task.status).toBe('done');
    expect(task.doneConfirmPending).toBe(false);
    expect(task.completedAt).not.toBeNull();

    // The member's board shows it in Done as well.
    await expectOnBoard(member.page, lp, title, 'Done');
  } finally {
    await member.page.context().close();
    await reviewer.page.context().close();
  }
});
