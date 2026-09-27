import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import {
  acceptDialogs,
  createInviteLink,
  createLeaderWithProject,
  joinAsNewUser,
  newUserPage,
  projectNav,
  uniqueUser,
  type LeaderProject,
  type User,
} from './helpers';

// Phase 5: copies and the IDE, on real containers started by the API. Needs Docker, the image
// (`npm run ide:build`), the network and firewall (scripts/ide-network.sh, ide-firewall.sh).

/** Same default as the API (`COPIES_DIR`, else `<repo root>/.data/copies`). */
const COPIES_DIR = resolve(process.env.COPIES_DIR || '.data/copies');
const IDE_ORIGIN = process.env.IDE_ORIGIN || 'http://127.0.0.1:3100';
const IDE_WS = IDE_ORIGIN.replace(/^http/, 'ws');
const API_PORT = Number(process.env.PORT || 3000);
const IDE_PORT = Number(process.env.IDE_PORT || 3100);

test.describe.configure({ mode: 'serial', timeout: 180_000 });

type Member = { user: User; page: Page; copyId: string };

/** Shared by the tests below (serial): one project, two members, their copies. */
const state: {
  lp?: LeaderProject;
  projectId?: string;
  first?: Member;
  second?: Member;
  launchUrl?: string;
  createdFile?: string;
} = {};

function copyDir(copyId: string) {
  return join(COPIES_DIR, state.projectId!, copyId);
}

function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function containerName(copyId: string) {
  return `devspace-ide-${copyId}`;
}

/** Can this machine (the host) open a TCP connection? The control for every isolation check. */
function hostCanConnect(host: string, port: number) {
  try {
    execFileSync('bash', ['-c', `timeout 4 bash -c '</dev/tcp/${host}/${port}'`]);
    return true;
  } catch {
    return false;
  }
}

/** Can the IDE container of `copyId` open a TCP connection? Runs inside it, as its own user. */
function containerCanConnect(copyId: string, host: string, port: number) {
  const out = docker(
    'exec',
    containerName(copyId),
    'bash',
    '-c',
    `timeout 4 bash -c '</dev/tcp/${host}/${port}' 2>/dev/null && echo open || echo blocked`,
  );
  return out === 'open';
}

async function getCopy(page: Page) {
  const res = await page.request.get(`/api/projects/${state.projectId}/copy`);
  expect(res.status()).toBe(200);
  return (await res.json()).copy as { id: string; containerStatus: string } | null;
}

async function setUpEmptyRepository(page: Page) {
  await projectNav(page, 'Files').click();
  await expect(
    page.getByRole('heading', { name: 'Set up the repository', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Start empty', exact: true }).check();
  await page.getByRole('button', { name: 'Set up repository', exact: true }).click();
  await expect(
    page.getByRole('main').getByRole('link', { name: 'README.md', exact: true }),
  ).toBeVisible();
}

async function addMember(leaderPage: Page, browser: Browser) {
  const user = uniqueUser();
  const link = await createInviteLink(leaderPage, user.email);
  const page = await newUserPage(browser);
  await joinAsNewUser(page, link, user, state.lp!);
  return { user, page };
}

/** VS Code's explorer inside the IDE iframe. */
function explorer(ide: FrameLocator) {
  return ide.locator('.explorer-folders-view');
}

test.afterAll(async () => {
  // Remove the containers this run started (their copies' files stay with the test data).
  for (const member of [state.first, state.second]) {
    if (member?.copyId) {
      try {
        docker('rm', '-f', containerName(member.copyId));
      } catch {
        // already gone
      }
    }
  }
});

test('a member opens the IDE, VS Code loads, and the terminal writes only to their copy', async ({
  page,
  browser,
}) => {
  acceptDialogs(page);
  state.lp = await createLeaderWithProject(page);
  state.projectId = state.lp.projectPath.split('/').pop()!;
  await setUpEmptyRepository(page);

  const { user, page: memberPage } = await addMember(page, browser);

  // Watch the IDE's WebSockets and console on the member's page (the iframe is part of it).
  const sockets: { url: string; received: number; closed: boolean }[] = [];
  memberPage.on('websocket', (ws) => {
    const info = { url: ws.url(), received: 0, closed: false };
    sockets.push(info);
    ws.on('framereceived', () => info.received++);
    ws.on('close', () => (info.closed = true));
  });
  const consoleLines: string[] = [];
  memberPage.on('console', (message) => consoleLines.push(message.text()));

  // Open IDE from the Overview.
  await projectNav(memberPage, 'Overview').click();
  await memberPage.getByRole('link', { name: 'Open IDE', exact: true }).click();
  await expect(memberPage).toHaveURL((url) => url.pathname === `${state.lp!.projectPath}/ide`);

  const frame = memberPage.getByTitle(`VS Code for ${state.lp.projectName}`, { exact: true });
  await expect(frame).toBeVisible({ timeout: 120_000 });
  const launchUrl = await frame.getAttribute('src');
  expect(launchUrl).toMatch(
    new RegExp(`^${IDE_ORIGIN.replace(/\./g, '\\.')}/ide-launch\\?ticket=`),
  );
  state.launchUrl = launchUrl!;

  const copy = await getCopy(memberPage);
  expect(copy?.containerStatus).toBe('running');
  state.first = { user, page: memberPage, copyId: copy!.id };

  // The explorer lists the copy's README.md: it comes from the container over the WebSocket.
  const ide = memberPage.frameLocator(`iframe[title="VS Code for ${state.lp.projectName}"]`);
  await expect(explorer(ide).getByText('README.md', { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // A workspace-trust prompt may ask first; trusting it is what a member would do.
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  // A file made in the IDE's terminal lands in this member's copy on disk.
  const fileName = `from-terminal-${Date.now()}.txt`;
  state.createdFile = fileName;
  await ide.locator('.monaco-workbench').click({ position: { x: 400, y: 300 } });
  await memberPage.keyboard.press('Control+Backquote');
  const terminal = ide.locator('.xterm').first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  const onDisk = join(copyDir(state.first.copyId), fileName);
  const contents = () => (existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : null);
  await expect(async () => {
    // Typed again only if nothing arrived (the terminal may not have had focus yet).
    if (contents() === null) {
      await terminal.click();
      await memberPage.keyboard.type(`node --version > /home/workspace/${fileName}\n`, {
        delay: 10,
      });
    }
    // The shell creates the file before node writes to it: wait for the content.
    await expect.poll(() => contents() ?? '', { timeout: 8_000 }).toMatch(/^v24\./);
  }).toPass({ timeout: 45_000 });
  await expect(explorer(ide).getByText(fileName, { exact: true })).toBeVisible();

  // The IDE's WebSocket connection stayed up and authenticated.
  const ideSockets = sockets.filter((s) =>
    s.url.startsWith(`${IDE_WS}/ide/${state.first!.copyId}/`),
  );
  expect(ideSockets.some((s) => s.received > 1 && !s.closed)).toBe(true);
  expect(consoleLines.filter((line) => /auth mismatch|Unauthorized client/i.test(line))).toEqual(
    [],
  );

  // Not in main: the leader's view of the repository doesn't have it.
  const tree = await page.request.get(`/api/projects/${state.projectId}/tree`);
  expect(tree.status()).toBe(200);
  const treeText = JSON.stringify(await tree.json());
  expect(treeText).toContain('README.md');
  expect(treeText).not.toContain(fileName);
});

test('another member cannot use the first member’s IDE', async ({ browser }) => {
  test.skip(!state.first, 'needs the first test');
  const leaderPage = await newUserPage(browser);
  // Log the leader in again in a fresh context to invite the second member.
  await leaderPage.goto('/login');
  await leaderPage.getByLabel('Email', { exact: true }).fill(state.lp!.leader.email);
  await leaderPage.getByLabel('Password', { exact: true }).fill(state.lp!.leader.password);
  await leaderPage.getByRole('button', { name: 'Log in' }).click();
  await expect(leaderPage.getByTestId('current-user')).toHaveText(state.lp!.leader.name);
  await leaderPage.goto(state.lp!.projectPath);

  const { user, page } = await addMember(leaderPage, browser);

  // Their own copy exists but isn't running: a launch is refused.
  const made = await page.request.post(`/api/projects/${state.projectId}/copy`, { data: {} });
  expect([200, 201]).toContain(made.status());
  const copyId = (await made.json()).copy.id as string;
  expect(copyId).not.toBe(state.first!.copyId);
  const launch = await page.request.post(`/api/projects/${state.projectId}/copy/ide/launch`, {
    data: {},
  });
  expect(launch.status()).toBe(409);
  expect(JSON.stringify(await launch.json())).toContain('ide_not_running');

  // The first member's (already used) ticket and IDE address both give a plain 404.
  const reused = await page.goto(state.launchUrl!);
  expect(reused?.status()).toBe(404);
  const direct = await page.goto(`${IDE_ORIGIN}/ide/${state.first!.copyId}/`);
  expect(direct?.status()).toBe(404);

  // The file made in the first member's terminal is not in this member's copy.
  expect(existsSync(join(copyDir(copyId), 'README.md'))).toBe(true);
  expect(existsSync(join(copyDir(copyId), state.createdFile!))).toBe(false);

  state.second = { user, page, copyId };
});

test('an IDE container is isolated from the host, the API, the databases and other copies', async () => {
  test.skip(!state.second, 'needs the tests above');
  const first = state.first!;
  const second = state.second!;

  // Start the second member's IDE too, so there is another copy's container to try to reach.
  const started = await second.page.request.post(`/api/projects/${state.projectId}/copy/ide`, {
    data: {},
  });
  expect(started.status()).toBe(200);
  await expect
    .poll(async () => (await getCopy(second.page))?.containerStatus, { timeout: 120_000 })
    .toBe('running');

  // Only its own copy is mounted, read-write, at /home/workspace; no Docker socket.
  const mounts = JSON.parse(
    docker('inspect', '-f', '{{json .Mounts}}', containerName(first.copyId)),
  ) as {
    Source: string;
    Destination: string;
    RW: boolean;
  }[];
  expect(mounts).toEqual([
    expect.objectContaining({
      Source: copyDir(first.copyId),
      Destination: '/home/workspace',
      RW: true,
    }),
  ]);
  const inside = docker(
    'exec',
    containerName(first.copyId),
    'bash',
    '-c',
    'ls -A /home/workspace; [ -e /var/run/docker.sock ] && echo DOCKER-SOCKET || true',
  );
  expect(inside).toContain(state.createdFile!);
  expect(inside).not.toContain('DOCKER-SOCKET');

  // The bridge's own address. Read from the interface, not `docker network inspect`: some Docker
  // versions (GitHub's runners) leave IPAM.Config's Gateway empty when it wasn't set explicitly.
  const gateway = execFileSync(
    'bash',
    ['-c', "ip -4 -o addr show dev br-dsp-ide | awk '{print $4}' | cut -d/ -f1 | head -n1"],
    { encoding: 'utf8' },
  ).trim();
  const hostIp = execFileSync(
    'bash',
    ['-c', 'ip -4 route get 1.1.1.1 | awk \'{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}\''],
    { encoding: 'utf8' },
  ).trim();
  const secondIp = docker(
    'inspect',
    '-f',
    '{{(index .NetworkSettings.Networks "devspace-ide").IPAddress}}',
    containerName(second.copyId),
  );
  // An empty address would make every check below meaningless, so stop with a clear reason.
  for (const [what, ip] of Object.entries({ gateway, hostIp, secondIp })) {
    expect(ip, `${what} must be an IPv4 address`).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }

  // Each target is reachable from the host (so a failure below is the isolation, not an empty
  // port), and unreachable from the IDE container.
  const targets: { what: string; host: string; port: number }[] = [
    { what: 'the API', host: hostIp, port: API_PORT },
    { what: 'the API via the bridge', host: gateway, port: API_PORT },
    { what: 'PostgreSQL', host: hostIp, port: 5432 },
    { what: 'Redis', host: hostIp, port: 6379 },
    { what: 'another copy’s IDE', host: secondIp, port: 3000 },
  ];
  for (const target of targets) {
    // Polled: in development `tsx watch` may be restarting the API for a moment.
    await expect
      .poll(() => hostCanConnect(target.host, target.port), {
        message: `host reaches ${target.what}`,
        timeout: 30_000,
      })
      .toBe(true);
    expect(
      containerCanConnect(first.copyId, target.host, target.port),
      `IDE reaches ${target.what}`,
    ).toBe(false);
  }
  // The IDE listener binds 127.0.0.1 only; from the container it is unreachable on every address.
  for (const host of [gateway, hostIp, '172.17.0.1']) {
    expect(
      containerCanConnect(first.copyId, host, IDE_PORT),
      `IDE reaches ${host}:${IDE_PORT}`,
    ).toBe(false);
  }
  // And the internet still works (npm install needs it).
  expect(containerCanConnect(first.copyId, '1.1.1.1', 443)).toBe(true);
});
