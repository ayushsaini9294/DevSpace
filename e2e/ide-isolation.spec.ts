import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  copyFolder,
  ideOriginFor,
  newUserPage,
  projectIdFrom,
  setUpEmptyRepository,
  setUpLeaderAndMember,
  writeInCopy,
} from './helpers';

// Phase 14 Done-when (a): every copy's IDE runs on its own address, and a page in one copy can't
// use another copy's IDE. The case that mattered (owner question, Phase 9): a member plants a page
// in their copy; a leader who also holds an IDE session for another copy opens that page through
// Preview. The page tries to read the other IDE with the leader's cookies, open its WebSocket
// (files and terminal), and post to its __devspace/presence: all three must fail, while the same
// calls work from the other copy's own IDE page. Real containers (devspace-ide:5, the IDE network
// and firewall), real Chromium.

test.describe.configure({ timeout: 300_000 });

const started: string[] = [];

test.afterAll(() => {
  for (const copyId of started) {
    try {
      docker('rm', '-f', `devspace-ide-${copyId}`);
    } catch {
      // already gone
    }
  }
});

function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

/** Does something answer HTTP on `port` inside the copy's container? */
function appAnswers(copyId: string, port: number) {
  try {
    const code = docker(
      'exec',
      `devspace-ide-${copyId}`,
      'curl',
      '-s',
      '-m',
      '3',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      `http://127.0.0.1:${port}/`,
    );
    return code !== '000';
  } catch {
    return false;
  }
}

type Probe = {
  /** fetch() of the IDE page with credentials (CORS mode): the page could read the IDE. */
  read: string;
  /** fetch() in no-cors mode (an opaque response is still a leak of cookies' effect). */
  noCors: string;
  /** WebSocket to VS Code's server: files and terminal. */
  ws: string;
  /** POST of a presence report as JSON (CORS mode, preflighted). */
  presenceJson: string;
};

/** The file name the probe's presence reports claim is open; it shows up in the project's presence if accepted. */
const MARKER = 'probe-marker.txt';

/**
 * The probe, as page code. It is both the member's planted page (attack.html in their copy,
 * served through Preview) and, for the control, run in the other copy's own IDE page.
 * Results are words, never exceptions, so both runs report the same way.
 */
const PROBE = `
window.devspaceProbe = async function (target, copyId, wsUrl, marker) {
  const base = target + '/ide/' + copyId + '/';
  const out = {};
  const settle = (p) => p.then((v) => v, (e) => 'blocked: ' + (e && e.name));
  out.read = await settle(
    fetch(base, { credentials: 'include' }).then(async (r) => 'read ' + r.status + ' ' + (await r.text()).length),
  );
  out.noCors = await settle(
    fetch(base, { credentials: 'include', mode: 'no-cors' }).then((r) => 'opaque ' + r.type),
  );
  out.ws = await new Promise((resolve) => {
    const url = new URL(wsUrl);
    url.searchParams.set('reconnectionToken', crypto.randomUUID());
    let ws;
    try { ws = new WebSocket(url.href); } catch (e) { resolve('blocked: ' + e.name); return; }
    const timer = setTimeout(() => { resolve('no answer'); ws.close(); }, 15000);
    ws.onopen = () => { clearTimeout(timer); resolve('open'); ws.close(); };
    ws.onerror = () => { clearTimeout(timer); resolve('blocked: error'); };
  });
  out.presenceJson = await settle(
    fetch(base + '__devspace/presence', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: marker, active: true }),
    }).then((r) => 'sent ' + r.status),
  );
  return out;
};
/** A plain HTML form POST (no CORS at all: the classic forged request), navigating this page. */
window.devspaceFormPost = function (target, copyId) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.enctype = 'text/plain';
  form.action = target + '/ide/' + copyId + '/__devspace/presence';
  const field = document.createElement('input');
  field.name = '{"file":"x","active":true,"pad":"';
  field.value = '"}';
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
};
`;

const ATTACK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Totally normal page</title></head>
<body><h1 id="ready">Nothing to see here</h1><script>${PROBE}</script></body></html>
`;

async function copyOf(page: Page, path: string) {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return (await res.json()).copy as { id: string; containerStatus: string } | null;
}

test('a page in one copy cannot use another copy’s IDE, even with the leader’s cookies', async ({
  page,
  browser,
}) => {
  // A leader and a member in one project with a repository.
  const { lp, memberPage } = await setUpLeaderAndMember(page, browser);
  await page.goto(lp.projectPath);
  await setUpEmptyRepository(page);
  const projectId = projectIdFrom(lp.projectPath);
  const api = `/api/projects/${projectId}`;

  // The member's copy (A) holds the planted page.
  const made = await memberPage.request.post(`${api}/copy`, { data: {} });
  expect([200, 201]).toContain(made.status());
  const copyA = (await made.json()).copy.id as string;
  const memberId = (await (await memberPage.request.get('/api/auth/me')).json()).user.id as string;
  writeInCopy(copyFolder(projectId, copyA), 'attack.html', ATTACK_PAGE);
  await memberPage.context().close();

  // The leader starts their own IDE (copy B) and the member's (A, as a lead helping).
  const ownStart = await page.request.post(`${api}/copy/ide`, { data: {} });
  expect(ownStart.status()).toBe(200);
  const copyB = (await ownStart.json()).copy.id as string;
  started.push(copyA, copyB);
  expect(copyB).not.toBe(copyA);
  expect(
    (await page.request.post(`${api}/members/${memberId}/copy/ide`, { data: {} })).status(),
  ).toBe(200);
  await expect
    .poll(async () => (await copyOf(page, `${api}/copy`))?.containerStatus, { timeout: 120_000 })
    .toBe('running');
  await expect
    .poll(async () => (await copyOf(page, `${api}/members/${memberId}/copy`))?.containerStatus, {
      timeout: 120_000,
    })
    .toBe('running');

  const originA = ideOriginFor(copyA);
  const originB = ideOriginFor(copyB);
  expect(new URL(originA).host).not.toBe(new URL(originB).host);

  // 1. The leader opens their own IDE (B) in a tab of their browser: VS Code connects.
  const ideB = await page.context().newPage();
  const sockets: { url: string; received: number }[] = [];
  ideB.on('websocket', (ws) => {
    const info = { url: ws.url(), received: 0 };
    sockets.push(info);
    ws.on('framereceived', () => info.received++);
  });
  const launchB = await page.request.post(`${api}/copy/ide/launch`, { data: {} });
  expect(launchB.status()).toBe(200);
  const launchUrlB = (await launchB.json()).url as string;
  expect(launchUrlB.startsWith(`${originB}/ide-launch?ticket=`)).toBe(true);
  await ideB.goto(launchUrlB);
  await expect(ideB).toHaveURL(`${originB}/ide/${copyB}/`);
  const wsPrefix = `${originB.replace(/^http/, 'ws')}/ide/${copyB}/`;
  await expect
    .poll(() => sockets.find((s) => s.url.startsWith(wsPrefix) && s.received > 1)?.url, {
      message: 'VS Code’s WebSocket on copy B connects',
      timeout: 90_000,
    })
    .toBeTruthy();
  const vscodeSocket = sockets.find((s) => s.url.startsWith(wsPrefix) && s.received > 1)!.url;

  // 2. The leader opens the member's Preview (A) in another tab: the planted page loads.
  // Preview keeps its path prefix (apps are built for it), so serve the copy under that prefix.
  const previewPath = `ide/${copyA}/__preview/8080`;
  inContainer(
    copyA,
    `mkdir -p /tmp/site/${previewPath} && ln -sf /home/workspace/attack.html /tmp/site/${previewPath}/attack.html && ` +
      'exec python3 -m http.server 8080 --directory /tmp/site >/tmp/attack.log 2>&1',
  );
  await expect.poll(() => appAnswers(copyA, 8080), { timeout: 30_000 }).toBe(true);
  const launchA = await page.request.post(`${api}/members/${memberId}/copy/preview/launch`, {
    data: { port: 8080 },
  });
  expect(launchA.status()).toBe(200);
  const launchUrlA = (await launchA.json()).url as string;
  expect(launchUrlA.startsWith(`${originA}/ide-launch?ticket=`)).toBe(true);
  const planted = await page.context().newPage();
  await planted.goto(launchUrlA);
  await expect(planted).toHaveURL(`${originA}/ide/${copyA}/__preview/8080/`);
  await planted.goto(`${originA}/ide/${copyA}/__preview/8080/attack.html`);
  await expect(planted.locator('#ready')).toBeVisible();

  type ProbeWindow = {
    devspaceProbe: (...a: string[]) => Promise<unknown>;
    devspaceFormPost: (target: string, copyId: string) => void;
  };
  const probe = (target: Page) =>
    target.evaluate(
      ([o, id, ws, marker]) =>
        (window as unknown as ProbeWindow).devspaceProbe(o!, id!, ws!, marker!),
      [originB, copyB, vscodeSocket, MARKER],
    ) as Promise<Probe>;
  /** Does the project's presence show the probe's marker as the leader's open file? */
  const markerShown = async () => {
    const res = await page.request.get(`${api}/presence`);
    expect(res.status()).toBe(200);
    return JSON.stringify(await res.json()).includes(MARKER);
  };
  /** Submits the forged form from `from` (navigating it) and returns copy B's answer. */
  const formPost = async (from: Page) => {
    const answer = from.waitForResponse(
      (res) =>
        new URL(res.url()).origin === originB &&
        new URL(res.url()).pathname === `/ide/${copyB}/__devspace/presence`,
    );
    await from.evaluate(
      ([o, id]) => (window as unknown as ProbeWindow).devspaceFormPost(o!, id!),
      [originB, copyB],
    );
    return (await answer).status();
  };

  // 3. From the planted page (copy A), against copy B: everything fails.
  const attack = await probe(planted);
  expect(attack.read, 'copy A reads copy B’s IDE').toMatch(/^blocked/);
  expect(attack.noCors, 'copy A loads copy B’s IDE (no-cors)').toMatch(/^blocked/);
  expect(attack.ws, 'copy A opens copy B’s WebSocket').not.toBe('open');
  expect(attack.presenceJson, 'copy A posts JSON to copy B').toMatch(/^blocked/);
  expect(await markerShown(), 'copy A’s presence report reached copy B').toBe(false);
  // A plain form POST needs no CORS at all; the server itself must refuse it.
  expect(await formPost(planted), 'a form POST from copy A to copy B').toBe(403);

  // 4. The same calls from copy B's own IDE page work.
  await ideB.evaluate(PROBE);
  const own = await probe(ideB);
  expect(own.read).toMatch(/^read 200 [1-9]/);
  expect(own.noCors).toMatch(/^opaque/);
  expect(own.ws).toBe('open');
  expect(own.presenceJson).toBe('sent 204');
  // Its report is accepted (sent again past the 5 s per-session limit if the tracker just reported).
  await expect(async () => {
    if (!(await markerShown())) {
      expect((await probe(ideB)).presenceJson).toBe('sent 204');
    }
    expect(await markerShown()).toBe(true);
  }).toPass({ timeout: 40_000, intervals: [6_000] });
  expect(await formPost(ideB), 'a form POST from copy B’s own page').toBe(204);

  // 5. And copy A's address can't be used for copy B's IDE at all (404, cookies or not).
  const crossed = await planted.goto(`${originA}/ide/${copyB}/`);
  expect(crossed?.status()).toBe(404);
  // A stranger (no IDE session) gets nothing from copy B either.
  const stranger = await newUserPage(browser);
  const strangerRes = await stranger.goto(`${originB}/ide/${copyB}/`);
  expect(strangerRes?.status()).toBe(404);
  await stranger.context().close();
});

/** Runs a shell command in the copy's container, in /home/workspace, in the background. */
function inContainer(copyId: string, command: string) {
  docker('exec', '-d', `devspace-ide-${copyId}`, 'bash', '-c', `cd /home/workspace && ${command}`);
}
