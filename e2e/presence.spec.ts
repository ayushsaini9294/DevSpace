import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import {
  addFileToMain,
  addMember,
  createLeaderWithProject,
  newUserPage,
  projectIdFrom,
  setUpEmptyRepository,
  topBar,
  type LeaderProject,
  type User,
} from './helpers';
import { execFileSync } from 'node:child_process';

// Phase 9 Done-when: teammates see "editing src/app.txt" live. The member's IDE runs DevSpace's
// tracker extension (image devspace-ide:4), which reports the open file through the IDE's own
// origin; the leader's project page updates over Socket.io without reloading. Also: the
// "Share my open file" switch, and the bell going up live when a reviewer approves.
// Needs Docker, the image (`npm run ide:build`), the IDE network and firewall, and Redis.

const APP_PATH = 'src/app.txt';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

type PresenceView = {
  user: { id: string; name: string };
  state: 'active' | 'online' | 'offline';
  file: string | null;
  copyOwner: { id: string; name: string } | null;
};

/** Shared by the tests below (serial): one project, a leader watching, a member in the IDE. */
const state: {
  lp?: LeaderProject;
  projectId?: string;
  leaderPage?: Page;
  member?: { user: User; page: Page; copyId: string; appTab?: Page };
} = {};

function ideFrame(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="VS Code for ${state.lp!.projectName}"]`);
}

/** The member's row in the Team panel. */
function teamRow(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Team', exact: true })
    .getByTestId('presence-member')
    .filter({ hasText: name });
}

async function presenceOf(page: Page, userId: string) {
  const res = await page.request.get(`/api/projects/${state.projectId}/presence`);
  expect(res.status()).toBe(200);
  const { members } = (await res.json()) as { members: PresenceView[] };
  return members.find((m) => m.user.id === userId);
}

/** Marks the page so a reload (which would clear it) can be detected. */
async function markNoReload(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}

async function expectNotReloaded(page: Page) {
  expect(
    await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);
}

async function currentUserId(page: Page) {
  const res = await page.request.get('/api/auth/me');
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.user?.id ?? body.id) as string;
}

test.afterAll(async () => {
  await state.leaderPage?.context().close();
  await state.member?.page.context().close();
  if (state.member?.copyId) {
    try {
      execFileSync('docker', ['rm', '-f', `devspace-ide-${state.member.copyId}`]);
    } catch {
      // already gone
    }
  }
});

test('a teammate sees "editing src/app.txt" live when a member opens it in the IDE', async ({
  browser,
}) => {
  // Own contexts (not the `page` fixture), so the pages live on through the serial tests.
  const page = await newUserPage(browser);
  const leaderFrames: string[] = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes('/socket.io/')) {
      ws.on('framereceived', (frame) => leaderFrames.push(String(frame.payload)));
    }
  });
  state.lp = await createLeaderWithProject(page);
  state.projectId = projectIdFrom(state.lp.projectPath);
  state.leaderPage = page;
  await setUpEmptyRepository(page);
  // src/app.txt on main before any copy exists, so the member's copy has it.
  addFileToMain(state.projectId, APP_PATH, 'hello from main\n');

  const { user, page: memberPage } = await addMember(page, browser, state.lp);

  // The leader watches the project overview; it must update without a reload.
  await page.goto(state.lp.projectPath);
  const row = teamRow(page, user.name);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('presence-file')).toHaveCount(0);
  await markNoReload(page);

  // The member opens the IDE and waits for VS Code's explorer.
  await memberPage.goto(state.lp.projectPath);
  await memberPage.getByRole('link', { name: 'Open IDE', exact: true }).click();
  const ide = ideFrame(memberPage);
  await expect(
    ide.locator('.explorer-folders-view').getByText('README.md', { exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  const copyRes = await memberPage.request.get(`/api/projects/${state.projectId}/copy`);
  const copyId = (await copyRes.json()).copy.id as string;
  state.member = { user, page: memberPage, copyId };

  // Quick Open (Ctrl+P) → src/app.txt, as a member would.
  await expect(async () => {
    await ide.locator('.monaco-workbench').click({ position: { x: 400, y: 300 } });
    await memberPage.keyboard.press('Control+P');
    const quickOpen = ide.locator('.quick-input-widget input');
    await expect(quickOpen).toBeVisible({ timeout: 5_000 });
    await quickOpen.fill(APP_PATH);
    await expect(ide.locator('.quick-input-list').getByText('app.txt').first()).toBeVisible({
      timeout: 5_000,
    });
    await memberPage.keyboard.press('Enter');
    await expect(ide.getByRole('tab', { name: /app\.txt/ })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  // Some typing in the editor: input, so the member is Active.
  await ide.locator('.monaco-editor .view-lines').first().click();
  await memberPage.keyboard.press('End');

  // The leader's page shows it live (the tracker reports within ~6 s)…
  await expect(row.getByTestId('presence-file')).toHaveText(`editing ${APP_PATH}`, {
    timeout: 20_000,
  });
  // …pushed over the app's Socket.io connection (a `presence` event), not by polling.
  expect(
    leaderFrames.some((frame) => frame.includes('"presence"') && frame.includes(APP_PATH)),
  ).toBe(true);
  await expect(row).toHaveAttribute('data-state', 'active');
  await expect(row.getByTestId('presence-state')).toHaveText('Active');
  await expectNotReloaded(page);

  // The API agrees (the leader asks, as a teammate).
  const memberId = await currentUserId(memberPage);
  const presence = await presenceOf(page, memberId);
  expect(presence).toMatchObject({ state: 'active', file: APP_PATH, copyOwner: null });
});

test('with "Share my open file" off, the teammate sees Active with no file', async () => {
  test.skip(!state.member, 'needs the first test');
  const { page: memberPage, user } = state.member!;
  const leaderPage = state.leaderPage!;

  // The IDE page is full screen (no top bar), so the member switches it off in a second tab of
  // the app, as they would, and keeps the IDE open.
  const appTab = await memberPage.context().newPage();
  state.member!.appTab = appTab;
  await appTab.goto(state.lp!.projectPath);
  await appTab.getByTestId('current-user').click();
  const share = appTab.getByRole('switch', { name: 'Share my open file', exact: true });
  // Disabled until the preferences have loaded.
  await expect(share).toBeEnabled();
  await expect(share).toHaveAttribute('aria-checked', 'true');
  await share.click();
  await expect(share).toHaveAttribute('aria-checked', 'false');
  await appTab.keyboard.press('Escape');
  const prefs = await appTab.request.get('/api/me/preferences');
  expect(await prefs.json()).toEqual({ shareOpenFile: false });

  // Back to the editor (focus and input), still with src/app.txt open.
  const ide = ideFrame(memberPage);
  await ide.locator('.monaco-editor .view-lines').first().click();
  await memberPage.keyboard.press('End');

  const row = teamRow(leaderPage, user.name);
  await expect(async () => {
    await expect(row).toHaveAttribute('data-state', 'active', { timeout: 1_000 });
    await expect(row.getByTestId('presence-file')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.getByTestId('presence-state')).toHaveText('Active');
  await expectNotReloaded(leaderPage);

  const presence = await presenceOf(leaderPage, await currentUserId(memberPage));
  expect(presence).toMatchObject({ state: 'active', file: null });
});

test('the author’s bell goes up live when a reviewer approves, and links to the submission', async () => {
  test.skip(!state.member, 'needs the first test');
  const { page: memberPage } = state.member!;
  const leaderPage = state.leaderPage!;
  const lp = state.lp!;

  // The member changes src/app.txt in the IDE's editor and submits it.
  const ide = ideFrame(memberPage);
  await ide.locator('.monaco-editor .view-lines').first().click();
  await memberPage.keyboard.press('Control+End');
  await memberPage.keyboard.type('changed in the IDE\n');
  await memberPage.keyboard.press('Control+S');
  await expect
    .poll(
      async () => {
        const res = await memberPage.request.get(`/api/projects/${state.projectId}/copy/changes`);
        const { files } = (await res.json()) as { files: { path: string }[] };
        return files.map((f) => f.path);
      },
      { timeout: 30_000 },
    )
    .toContain(APP_PATH);
  const submitted = await memberPage.request.post(`/api/projects/${state.projectId}/submissions`, {
    data: { title: 'Change app.txt', description: '', paths: [APP_PATH] },
  });
  expect(submitted.status()).toBe(201);
  const submissionId = (await submitted.json()).submission.id as string;

  // No unread notifications yet. The member watches the bell in their app tab (the IDE page is
  // full screen, without the top bar).
  const appTab = state.member!.appTab!;
  await appTab.goto(lp.projectPath);
  const bell = topBar(appTab).getByRole('button', { name: 'Notifications', exact: true });
  await expect(bell).toBeVisible();
  const count = appTab.getByTestId('notification-count');
  await expect(count).toHaveCount(0);
  await markNoReload(appTab);

  // The leader reviews and approves on the review page.
  await leaderPage.goto(`${lp.projectPath}/submissions/${submissionId}`);
  await leaderPage.getByRole('button', { name: 'Approve', exact: true }).click();
  await leaderPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(leaderPage.getByTestId('submission-status')).toHaveText('Approved');

  // The API has the notification for the author…
  await expect
    .poll(
      async () => {
        const res = await appTab.request.get('/api/notifications');
        const body = (await res.json()) as {
          unreadCount: number;
          notifications: { type: string }[];
        };
        return { unreadCount: body.unreadCount, types: body.notifications.map((n) => n.type) };
      },
      { timeout: 10_000 },
    )
    .toEqual({ unreadCount: 1, types: ['submission.reviewed'] });

  // …and the author's bell goes up without a reload…
  await expect(count).toHaveText('1', { timeout: 20_000 });
  await expectNotReloaded(appTab);

  // …and the notification links to the submission.
  await topBar(appTab).getByRole('button', { name: 'Notifications', exact: true }).click();
  const list = appTab.getByRole('list', { name: 'Notifications' });
  const link = list.getByRole('link', { name: /approved your submission/ });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', `${lp.projectPath}/submissions/${submissionId}`);
  await link.click();
  await expect(appTab).toHaveURL(
    (url) => url.pathname === `${lp.projectPath}/submissions/${submissionId}`,
  );
  await expect(appTab.getByTestId('submission-status')).toHaveText('Approved');
  // Opening it marked it read.
  await expect(count).toHaveCount(0);
});
