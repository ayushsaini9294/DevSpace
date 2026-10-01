import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  addMember,
  copyFolder,
  createLeaderWithProject,
  newUserPage,
  projectIdFrom,
  projectNav,
  setUpEmptyRepository,
  type LeaderProject,
} from './helpers';

// Phase 12 Done-when: a member opens the IDE, asks the built-in AI assistant (Cline, pre-installed
// in devspace-ide:5 and connected by the image's start script) to build something, and the code
// appears in their copy, with no extension to install and no key to copy.
// Cline talks to DevSpace's AI gateway (10.213.0.1:3200, the only host port the IDE firewall
// lets a container reach), which adds the member's OpenRouter key and forwards to the stand-in
// OpenRouter (a test double, e2e/stubs/openrouter.ts). The stand-in answers like a model: it asks
// Cline's `editor` tool to create hello-from-ai.html, and Cline asks the member before writing.
// The member's key never enters the container: its env and files are searched for it.
// Needs Docker, the image (`npm run ide:build`), the IDE network and firewall, and Redis.

const STUB = `http://127.0.0.1:${process.env.OPENROUTER_STUB_PORT || '4010'}`;
const MODEL = 'qwen/qwen3.8-27b:free';
const FILE = 'hello-from-ai.html';
const FILE_TEXT = '<h1>Hello from the AI helper</h1>\n';

type StubRequest = {
  path: string;
  status: number;
  model?: string;
  authorized?: boolean;
  keyEnding?: string;
  assistant?: boolean;
  stream?: boolean;
};

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const state: { leaderPage?: Page; memberPage?: Page; copyId?: string } = {};

test.afterAll(async () => {
  await state.leaderPage?.context().close();
  await state.memberPage?.context().close();
  if (state.copyId) {
    try {
      execFileSync('docker', ['rm', '-f', `devspace-ide-${state.copyId}`]);
    } catch {
      // already gone
    }
  }
});

async function assistantRequests(page: Page) {
  const res = await page.request.get(`${STUB}/__stub/requests`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { requests: StubRequest[] }).requests.filter(
    (r) => r.path === '/api/v1/chat/completions' && r.assistant,
  );
}

/** Cline's chat: the webview frame (inside the IDE's iframe) that has its task box. */
async function clineChat(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const box = frame.getByPlaceholder(/Type your task here/);
          if (await box.isVisible().catch(() => false)) {
            found = frame;
            return true;
          }
        }
        return false;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return found!;
}

test('a member asks the built-in AI assistant to build something, and it lands in their copy', async ({
  browser,
}) => {
  // Leader: project with an empty repository; a member joins.
  const page = await newUserPage(browser);
  state.leaderPage = page;
  const lp: LeaderProject = await createLeaderWithProject(page);
  const projectId = projectIdFrom(lp.projectPath);
  await setUpEmptyRepository(page);
  const member = await addMember(page, browser, lp);
  const mp = member.page;
  state.memberPage = mp;

  // The member connects OpenRouter (the stand-in) and accepts the AI notice on Settings → AI.
  await mp.goto('/settings/ai');
  await expect(mp.getByRole('heading', { level: 2, name: 'AI settings' })).toBeVisible();
  await mp.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
  await expect(mp).toHaveURL((url) => url.origin === STUB && url.pathname === '/auth');
  await mp.getByRole('link', { name: 'Authorize DevSpace', exact: true }).click();
  await expect(mp).toHaveURL((url) => url.pathname === '/settings/ai');
  await expect(mp.getByTestId('ai-connection-status')).toHaveText('Connected');
  const ending = await mp.getByText(/Key ending in …[A-Za-z0-9]{4}/).textContent();
  const keyEnding = /…([A-Za-z0-9]{4})/.exec(ending ?? '')![1]!;
  const notice = mp.getByTestId('ai-notice');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'I understand', exact: true }).click();
  await expect(notice).toHaveCount(0);

  // The leader allows AI in the project.
  await page.goto(lp.projectPath);
  await projectNav(page, 'Settings').click();
  const aiSwitch = page.getByLabel(
    'Allow AI (AI review and the IDE assistant; sends code to AI providers)',
    { exact: true },
  );
  await aiSwitch.check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // The member opens the IDE: the page says the assistant is ready.
  await mp.goto(lp.projectPath);
  await mp.getByRole('link', { name: 'Open IDE', exact: true }).click();
  await expect(mp).toHaveURL((url) => url.pathname === `${lp.projectPath}/ide`);
  const frame = mp.getByTitle(`VS Code for ${lp.projectName}`, { exact: true });
  await expect(frame).toBeVisible({ timeout: 120_000 });
  const hint = mp.getByTestId('ide-ai-hint');
  await expect(hint).toHaveAttribute('data-ready', 'true');
  await expect(hint).toContainText('Click the AI icon on the left and describe what to build.');
  const copyRes = await mp.request.get(`/api/projects/${projectId}/copy`);
  const copy = (await copyRes.json()).copy as {
    id: string;
    aiAssistant: { ready: boolean; reason: string | null };
  };
  state.copyId = copy.id;
  expect(copy.aiAssistant).toEqual({ ready: true, reason: null });

  const ide = mp.frameLocator(`iframe[title="VS Code for ${lp.projectName}"]`);
  await expect(
    ide.locator('.explorer-folders-view').getByText('README.md', { exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  // VS Code's workspace-trust prompt (since Phase 5): trusting their own copy is what a member does.
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  // Cline is already there and connected: its icon on the left opens the chat, with no setup.
  await ide
    .locator('.activitybar')
    .getByRole('tab', { name: /^Cline/ })
    .click();
  const chat = await clineChat(mp);
  await expect(chat.getByText(`openai-compat:${MODEL}`)).toBeVisible();
  const before = (await assistantRequests(mp)).length;

  // The member describes what to build.
  const box = chat.getByPlaceholder(/Type your task here/);
  await box.fill('Make a web page that says hello');
  await box.press('Enter');

  // The request reached the stand-in OpenRouter through the gateway, with the member's own key.
  await expect
    .poll(async () => (await assistantRequests(mp)).length, { timeout: 60_000 })
    .toBeGreaterThan(before);
  const first = (await assistantRequests(mp))[before]!;
  expect(first).toMatchObject({
    status: 200,
    model: MODEL,
    authorized: true,
    keyEnding,
    stream: true,
  });

  // Cline asks before it writes the file (no auto-approve for edits); the member says yes.
  const onDisk = join(copyFolder(projectId, copy.id), FILE);
  const save = chat.getByRole('button', { name: /^(Save|Approve)$/ });
  await expect(save).toBeVisible({ timeout: 60_000 });
  await expect(chat.getByText('Cline wants to create a new file:')).toBeVisible();
  await save.click();

  // The code is in the member's copy, and the IDE shows it.
  await expect
    .poll(() => (existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : ''), { timeout: 30_000 })
    .toBe(FILE_TEXT);
  await expect(chat.getByText('Done: hello-from-ai.html is in your copy.')).toBeVisible({
    timeout: 60_000,
  });
  await ide
    .locator('.activitybar')
    .getByRole('tab', { name: /^Explorer/ })
    .click();
  await expect(ide.locator('.explorer-folders-view').getByText(FILE, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Cline sent the tool's result back and finished (a second request, same key).
  await expect
    .poll(async () => (await assistantRequests(mp)).length, { timeout: 60_000 })
    .toBeGreaterThan(before + 1);
  for (const r of (await assistantRequests(mp)).slice(before)) {
    expect(r).toMatchObject({ status: 200, authorized: true, keyEnding });
  }

  // The member's OpenRouter key is nowhere in the container: not in its settings, not in any
  // process's environment, not in any file (the stand-in's keys all start with sk-or-v1-stub).
  const name = `devspace-ide-${copy.id}`;
  const configEnv = execFileSync('docker', ['inspect', '-f', '{{json .Config.Env}}', name], {
    encoding: 'utf8',
  });
  expect(configEnv).toContain('DEVSPACE_AI_TOKEN=');
  expect(configEnv).not.toContain('sk-or-v1-stub');
  const search = execFileSync(
    'docker',
    [
      'exec',
      name,
      'sh',
      '-c',
      // As the member's own user, so their private files (Cline's secrets) are searched too.
      'envs=$(cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c sk-or-v1-stub); ' +
        'files=$(grep -rlsa --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev sk-or-v1-stub / | wc -l); ' +
        'cline=$(grep -c "\\"openAiApiKey\\"" "$HOME/.cline/data/secrets.json"); ' +
        'echo "$envs $files $cline"',
    ],
    { encoding: 'utf8', timeout: 180_000 },
  ).trim();
  // 0 environments and 0 files with the key; Cline's API key is set (it is the gateway token).
  expect(search).toBe('0 0 1');
});
