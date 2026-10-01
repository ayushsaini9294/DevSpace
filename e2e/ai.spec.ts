import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import {
  addFileToMain,
  addMember,
  copyFolder,
  createLeaderWithProject,
  grantPermission,
  newUserPage,
  projectIdFrom,
  projectNav,
  setUpEmptyRepository,
  writeInCopy,
  type LeaderProject,
  type User,
} from './helpers';

// Phase 10 Done-when: a member with no paid plan gets two free AI reviews of a submission.
// Every OpenRouter call goes to the stand-in OpenRouter (a test double, e2e/stubs/openrouter.ts)
// that playwright.config.ts starts and points the API and worker at (OPENROUTER_BASE_URL). In it,
// google/gemma-4-31b-it:free always answers 429, so DevSpace falls back to the next free model,
// and qwen and nemotron-ultra report the same place, so their findings form an agreed group.
// The second test covers "Review with my IDE AI" and the tracker's "DevSpace: Send review
// findings" command, run from VS Code's command palette in the reviewer's real IDE container
// (image devspace-ide:5; needs Docker, the IDE network and firewall, and Redis).

const STUB = `http://127.0.0.1:${process.env.OPENROUTER_STUB_PORT || '4010'}`;

const QWEN = 'qwen/qwen3.8-27b:free';
const NEMOTRON_ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const GEMMA = 'google/gemma-4-31b-it:free';
/** The first fallback: answers in place of GEMMA. */
const LAGUNA = 'poolside/laguna-s-2.1:free';

const APP_PATH = 'src/app.ts';
const APP_BASE = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`)
  .join('\n')
  .concat('\n');
/** Line 12 changes, so git's hunk starts at line 9 (3 lines of context): the stand-in reports 9. */
const APP_NEW = APP_BASE.replace(
  'export const line12 = 12;',
  'export const line12 = process.argv[2]!.trim();',
);
const HUNK_LINE = 9;

test.describe.configure({ mode: 'serial', timeout: 240_000 });

type ReviewView = {
  id: string;
  source: 'auto' | 'ide';
  model: string;
  requestedModel: string;
  isFree: boolean | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  findings: { path: string; line: number | null; severity: string; title: string }[];
  error: string | null;
};
type Group = {
  path: string;
  startLine: number | null;
  agreedBy: string[];
  findings: { model: string; title: string }[];
};
type StubRequest = { path: string; status: number; model?: string; authorized?: boolean };

/** Shared by the two tests below (serial). */
const state: {
  lp?: LeaderProject;
  projectId?: string;
  submissionId?: string;
  leaderPage?: Page;
  reviewer?: { user: User; page: Page };
  authorPage?: Page;
  reviewerCopyId?: string;
} = {};

function reviewUrl() {
  return `${state.lp!.projectPath}/submissions/${state.submissionId}`;
}

function aiSection(page: Page) {
  return page.getByRole('region', { name: 'AI review', exact: true });
}

async function aiReviews(page: Page) {
  const res = await page.request.get(
    `/api/projects/${state.projectId}/submissions/${state.submissionId}/ai-reviews`,
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as { reviews: ReviewView[]; groups: Group[]; running: boolean };
}

async function stubRequests(page: Page) {
  const res = await page.request.get(`${STUB}/__stub/requests`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { requests: StubRequest[] }).requests;
}

function ideFrame(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="VS Code for ${state.lp!.projectName}"]`);
}

test.afterAll(async () => {
  await state.leaderPage?.context().close();
  await state.reviewer?.page.context().close();
  await state.authorPage?.context().close();
  if (state.reviewerCopyId) {
    try {
      execFileSync('docker', ['rm', '-f', `devspace-ide-${state.reviewerCopyId}`]);
    } catch {
      // already gone
    }
  }
});

test('a member with no paid plan connects OpenRouter and gets two free AI reviews, with an agreed finding', async ({
  browser,
}) => {
  // Leader: project, repository with src/app.ts on main (before any copy exists).
  const page = await newUserPage(browser);
  state.leaderPage = page;
  state.lp = await createLeaderWithProject(page);
  state.projectId = projectIdFrom(state.lp.projectPath);
  const projectId = state.projectId;
  await setUpEmptyRepository(page);
  addFileToMain(projectId, APP_PATH, APP_BASE);

  // An author, and a reviewer the leader gives "AI cross-review" (a plain member otherwise).
  const author = await addMember(page, browser, state.lp);
  state.authorPage = author.page;
  const reviewer = await addMember(page, browser, state.lp);
  state.reviewer = reviewer;
  await page.goto(state.lp.projectPath);
  await projectNav(page, 'Members').click();
  await expect(page).toHaveURL(/\/members$/);
  await grantPermission(page, reviewer.user, 'AI cross-review');

  // The author changes line 12 of src/app.ts in their copy (on disk, as the IDE would) and submits.
  const made = await author.page.request.post(`/api/projects/${projectId}/copy`, { data: {} });
  expect([200, 201]).toContain(made.status());
  const authorCopy = (await made.json()).copy.id as string;
  writeInCopy(copyFolder(projectId, authorCopy), APP_PATH, APP_NEW);
  await expect
    .poll(async () => {
      const res = await author.page.request.get(`/api/projects/${projectId}/copy/changes`);
      return ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path);
    })
    .toEqual([APP_PATH]);
  const submitted = await author.page.request.post(`/api/projects/${projectId}/submissions`, {
    data: { title: 'Read line 12 from the command line', description: '', paths: [APP_PATH] },
  });
  expect(submitted.status()).toBe(201);
  state.submissionId = (await submitted.json()).submission.id as string;

  // The project switch is off by default: every AI route answers 409 ai_disabled.
  const whileOff = await reviewer.page.request.post(
    `/api/projects/${projectId}/submissions/${state.submissionId}/ai-reviews`,
    { data: {} },
  );
  expect(whileOff.status()).toBe(409);
  expect((await whileOff.json()).error).toBe('ai_disabled');

  // The reviewer connects OpenRouter: DevSpace → the (stand-in) OpenRouter page → back.
  const rp = reviewer.page;
  await rp.goto('/settings/ai');
  await expect(rp.getByRole('heading', { level: 2, name: 'AI settings' })).toBeVisible();
  await expect(rp.getByTestId('ai-connection-status')).toHaveText('Not connected');
  await rp.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
  await expect(rp).toHaveURL((url) => url.origin === STUB && url.pathname === '/auth');
  const auth = new URL(rp.url());
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const callback = new URL(auth.searchParams.get('callback_url')!);
  expect(callback.origin + callback.pathname).toBe('http://localhost:5173/settings/ai/callback');
  expect(callback.searchParams.get('state')).toBeTruthy();
  await rp.getByRole('link', { name: 'Authorize DevSpace', exact: true }).click();

  await expect(rp).toHaveURL((url) => url.pathname === '/settings/ai');
  await expect(rp.getByText('OpenRouter connected.')).toBeVisible();
  await expect(rp.getByTestId('ai-connection-status')).toHaveText('Connected');
  await expect(rp.getByText(/Key ending in …[A-Za-z0-9]{4}/)).toBeVisible();
  await expect(rp.getByTestId('ai-free-requests')).toContainText('50');
  // The key itself never reaches the browser.
  const connection = await rp.request.get('/api/ai/connection');
  expect(connection.status()).toBe(200);
  const connectionText = await connection.text();
  expect(connectionText).not.toContain('sk-or-v1');
  expect(JSON.parse(connectionText)).toMatchObject({
    connected: true,
    freeRequestsToday: { limit: 50 },
  });
  expect(await rp.content()).not.toContain('sk-or-v1');

  // The leader switches AI review on for the project.
  await page.goto(state.lp.projectPath);
  await projectNav(page, 'Settings').click();
  const aiSwitch = page.getByLabel(
    'Allow AI (AI review and the IDE assistant; sends code to AI providers)',
    { exact: true },
  );
  await expect(aiSwitch).not.toBeChecked();
  await aiSwitch.check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // The reviewer cross-reviews with the free defaults, after the one-time notice.
  await rp.goto(reviewUrl());
  const section = aiSection(rp);
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Cross-review with AI', exact: true }).click();
  const notice = rp.getByRole('dialog', { name: 'Before your first AI review' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'I understand, continue', exact: true }).click();
  await expect(notice).toHaveCount(0);

  // Live status per model: three free reviews finish; gemma's 429 fell back to laguna.
  const statuses = section.getByTestId('ai-model-status');
  await expect(statuses).toHaveCount(3, { timeout: 30_000 });
  await expect(statuses.and(rp.locator('[data-status="done"]'))).toHaveCount(3, {
    timeout: 60_000,
  });
  for (const model of [QWEN, NEMOTRON_ULTRA, LAGUNA]) {
    await expect(statuses.filter({ hasText: model })).toHaveCount(1);
  }

  // Findings grouped by file; the two models that agree are highlighted.
  await expect(section.getByRole('heading', { level: 4, name: APP_PATH })).toBeVisible();
  const groups = section.getByTestId('ai-finding-group');
  const agreed = groups.and(rp.locator('[data-agreed="true"]'));
  await expect(agreed).toHaveCount(1);
  await expect(agreed).toContainText('Agreed by 2 models');
  await expect(agreed).toContainText('Unchecked input is used directly');
  await expect(agreed).toContainText(QWEN);
  await expect(agreed).toContainText(NEMOTRON_ULTRA);
  const single = groups.and(rp.locator('[data-agreed="false"]'));
  await expect(single).toHaveCount(1);
  await expect(single).toContainText('Consider a clearer name');
  await expect(single).toContainText(LAGUNA);

  // The API agrees…
  const { reviews, groups: apiGroups } = await aiReviews(rp);
  const auto = reviews.filter((r) => r.source === 'auto');
  expect(auto.map((r) => r.status)).toEqual(['done', 'done', 'done']);
  expect(auto.every((r) => r.isFree === true)).toBe(true);
  expect(auto.filter((r) => r.findings.length > 0)).toHaveLength(3);
  const fallback = auto.find((r) => r.model === LAGUNA);
  expect(fallback?.requestedModel).toBe(GEMMA);
  const agreedGroup = apiGroups.find((g) => g.agreedBy.length >= 2);
  expect(agreedGroup).toMatchObject({ path: APP_PATH, startLine: HUNK_LINE });
  expect([...agreedGroup!.agreedBy].sort()).toEqual([NEMOTRON_ULTRA, QWEN].sort());

  // …and so does the stand-in: gemma was asked and answered 429, then laguna; all with the key.
  const chats = (await stubRequests(rp)).filter((r) => r.path === '/api/v1/chat/completions');
  const ours = chats.filter((r) => [QWEN, NEMOTRON_ULTRA, GEMMA, LAGUNA].includes(r.model ?? ''));
  expect(ours.find((r) => r.model === GEMMA)?.status).toBe(429);
  expect(ours.find((r) => r.model === LAGUNA)?.status).toBe(200);
  expect(ours.every((r) => r.authorized)).toBe(true);

  // The reviewer is told when the reviews have finished.
  await expect
    .poll(async () => {
      const res = await rp.request.get('/api/notifications');
      const body = (await res.json()) as { notifications: { type: string }[] };
      return body.notifications.map((n) => n.type);
    })
    .toContain('ai_review.finished');
});

test('"Review with my IDE AI": the findings come back with "DevSpace: Send review findings" in VS Code', async () => {
  // Serial: runs only after the first test passed, with its project, submission and reviewer.
  const rp = state.reviewer!.page;
  const projectId = state.projectId!;
  const submissionId = state.submissionId!;

  await rp.goto(reviewUrl());
  const section = aiSection(rp);
  await section.getByRole('button', { name: 'Review with my IDE AI', exact: true }).click();
  // The reviewer's own IDE opens.
  await expect(rp).toHaveURL((url) => url.pathname === `/projects/${projectId}/ide`, {
    timeout: 30_000,
  });
  const ide = ideFrame(rp);
  await expect(
    ide.locator('.explorer-folders-view').getByText('README.md', { exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  // The review folder is in the reviewer's own copy, and never counts as a change to submit.
  const copyRes = await rp.request.get(`/api/projects/${projectId}/copy`);
  const copyId = (await copyRes.json()).copy.id as string;
  state.reviewerCopyId = copyId;
  const folder = join(copyFolder(projectId, copyId), '.devspace', 'reviews', submissionId);
  for (const file of ['REVIEW.md', 'changes.diff', 'findings.md']) {
    expect(existsSync(join(folder, file)), file).toBe(true);
  }
  expect(readFileSync(join(folder, 'changes.diff'), 'utf8')).toContain(
    '+export const line12 = process.argv[2]!.trim();',
  );
  const changes = await rp.request.get(`/api/projects/${projectId}/copy/changes`);
  expect(((await changes.json()) as { files: { path: string }[] }).files).toEqual([]);

  // The reviewer's IDE AI writes its findings into findings.md…
  const ideFinding = {
    path: APP_PATH,
    line: 12,
    severity: 'high',
    title: 'Crashes without an argument',
    detail: 'process.argv[2] is undefined when no argument is given.',
  };
  writeInCopy(
    copyFolder(projectId, copyId),
    `.devspace/reviews/${submissionId}/findings.md`,
    `${JSON.stringify([ideFinding], null, 2)}\n`,
  );

  // …and the reviewer runs "DevSpace: Send review findings" from the command palette.
  await expect(async () => {
    await ide.locator('.monaco-workbench').click({ position: { x: 400, y: 300 } });
    await rp.keyboard.press('Control+P');
    const quickInput = ide.locator('.quick-input-widget input');
    await expect(quickInput).toBeVisible({ timeout: 5_000 });
    await quickInput.fill('>DevSpace: Send review findings');
    await expect(
      ide.locator('.quick-input-list').getByText('DevSpace: Send review findings').first(),
    ).toBeVisible({ timeout: 5_000 });
    await rp.keyboard.press('Enter');
    await expect(
      ide.locator('.notifications-toasts').getByText(/Review findings sent to DevSpace/),
    ).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });

  // The API stored it as an IDE review, reported by the reviewer, parsed like the others.
  const reporter = `IDE AI (reported by ${state.reviewer!.user.name})`;
  const { reviews, groups } = await aiReviews(rp);
  const fromIde = reviews.filter((r) => r.source === 'ide');
  expect(fromIde).toHaveLength(1);
  expect(fromIde[0]).toMatchObject({ model: reporter, isFree: null, status: 'done' });
  expect(fromIde[0]!.findings).toEqual([
    expect.objectContaining({ path: APP_PATH, line: 12, title: ideFinding.title }),
  ]);
  expect(groups.some((g) => g.agreedBy.includes(reporter))).toBe(true);

  // The review page shows it too.
  await rp.goto(reviewUrl());
  const reviewSection = aiSection(rp);
  await expect(
    reviewSection.getByTestId('ai-model-status').filter({ hasText: reporter }),
  ).toHaveAttribute('data-status', 'done');
  await expect(
    reviewSection.getByTestId('ai-finding-group').filter({ hasText: ideFinding.title }),
  ).toHaveCount(1);
});
