import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GithubAccountViewSchema,
  GithubRepoListResponseSchema,
  ProjectGithubViewSchema,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { useGithubConfig } from '../src/github/config.ts';
import { runGithubSync } from '../src/github/link.ts';
import { runHousekeeping } from '../src/housekeeping/index.ts';
import { takeQueuedGithubSyncs } from '../src/jobs/github-sync.ts';
import { prisma } from '../src/lib/prisma.ts';
import { waitForImports } from '../src/repository/import.ts';
import { closeEmitter } from '../src/realtime/emitter.ts';
import {
  addMember,
  as,
  cleanUp,
  commitFiles,
  createProject,
  createTeam,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';
import { startGithubStub, type GithubStub } from './github-stub.ts';
import {
  approve,
  git,
  mainSha,
  merge,
  revert,
  setPermissions,
  setSettings,
  submit,
  url,
  world,
  write,
} from './phase7.ts';

vi.setConfig({ testTimeout: 60_000 });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const APP = {
  appId: '4242',
  slug: 'devspace-test',
  clientId: 'Iv1.test',
  clientSecret: 'stub-secret-123456',
};

let stub: GithubStub;
const logged: string[] = [];
const responses: string[] = [];
let gitLog: string;
let wrapperDir: string;
const originalPath = process.env.PATH;

/** Keeps every API response body, so we can check no token ever reached one. */
function keep(res: request.Response): request.Response {
  responses.push(JSON.stringify(res.body ?? null) + String(res.text ?? ''));
  return res;
}

function configure() {
  useGithubConfig({
    ...APP,
    privateKey,
    apiUrl: stub.apiUrl,
    webUrl: stub.url,
    allowHttp: true,
  });
}

beforeAll(async () => {
  stub = await startGithubStub({ ...APP, publicKey });
  configure();
  // Every git command is logged with its arguments (a wrapper in front of the real git).
  wrapperDir = mkdtempSync(join(tmpdir(), 'devspace-gitwrap-'));
  gitLog = join(wrapperDir, 'argv.log');
  writeFileSync(gitLog, '');
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(
    join(wrapperDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(join(wrapperDir, 'git'), 0o755);
  process.env.PATH = `${wrapperDir}:${originalPath}`;
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
      original(...args);
    });
  }
});

beforeEach(() => {
  configure();
  takeQueuedGithubSyncs();
});

afterAll(async () => {
  // No token GitHub handed out ever reached git's arguments, a log line or a response.
  const argv = readFileSync(gitLog, 'utf8');
  expect(argv).toContain('push');
  for (const t of stub.issuedTokens) {
    expect(argv).not.toContain(t);
    for (const line of logged) expect(line).not.toContain(t);
    for (const body of responses) expect(body).not.toContain(t);
  }
  expect(argv).not.toMatch(/--force|\+[0-9a-f]{40}:/);
  process.env.PATH = originalPath;
  rmSync(wrapperDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  useGithubConfig(null);
  await stub.close();
  await closeEmitter();
  await cleanUp();
});

async function connect(user: TestUser, login: string) {
  stub.nextLogin = login;
  const start = keep(await as(user).post('/api/github/connect/start'));
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const back = await stub.login(start.body.url);
  expect(back.origin + back.pathname).toBe(`${env.APP_ORIGIN}/settings/github/callback`);
  const finish = keep(
    await as(user).post('/api/github/connect/finish', {
      code: back.searchParams.get('code'),
      state: back.searchParams.get('state'),
    }),
  );
  expect(finish.status, JSON.stringify(finish.body)).toBe(200);
  return GithubAccountViewSchema.parse(finish.body);
}

async function projectView(user: TestUser, projectId: string) {
  const res = keep(await as(user).get(`/api/projects/${projectId}/github`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ProjectGithubViewSchema.parse(res.body);
}

async function readyProject(leader: TestUser, name = 'GH Project') {
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, name);
  const setup = await as(leader).post(`/api/projects/${project.id}/repository`, {
    source: 'template',
    template: 'html',
  });
  expect(setup.status).toBe(202);
  const gitDir = (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).repoPath!;
  return { projectId: project.id, gitDir };
}

describe('not configured', () => {
  it('says so clearly everywhere and breaks nothing', async () => {
    useGithubConfig({ appId: '' });
    const user = await signUp('Nora None');
    const account = keep(await as(user).get('/api/github/account'));
    expect(GithubAccountViewSchema.parse(account.body)).toMatchObject({
      configured: false,
      connected: false,
      installUrl: null,
    });
    expectError(await as(user).post('/api/github/connect/start'), 409, 'github_not_configured');
    expectError(
      await as(user).post('/api/github/connect/finish', { code: 'x', state: 'y' }),
      409,
      'github_not_configured',
    );
    expectError(await as(user).get('/api/github/repos'), 409, 'github_not_configured');
    const { projectId } = await readyProject(user);
    const view = await projectView(user, projectId);
    expect(view).toMatchObject({ configured: false, canPublish: false, link: null });
    expectError(
      await as(user).post(`/api/projects/${projectId}/github/publish`, {
        name: 'x',
        mode: 'publish_once',
      }),
      409,
      'github_not_configured',
    );
    expectError(
      await as(user).post(`/api/projects/${projectId}/repository`, {
        source: 'github',
        repoFullName: 'a/b',
      }),
      409,
      'github_not_configured',
    );
  });
});

describe('connect', () => {
  it('connects with PKCE, stores tokens encrypted and refreshes them', async () => {
    const user = await signUp('Cara Connect');
    const view = await connect(user, 'cara-gh');
    expect(view).toMatchObject({
      configured: true,
      connected: true,
      login: 'cara-gh',
      appInstalled: false,
    });
    expect(view.installUrl).toBe(`${stub.url}/apps/devspace-test/installations/new`);
    const row = await prisma.githubAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.githubUserId).toBe(BigInt(stub.userId('cara-gh')));
    for (const t of stub.issuedTokens) {
      expect(row.encryptedAccessToken).not.toContain(t);
      expect(row.encryptedRefreshToken ?? '').not.toContain(t);
    }
    // The authorize URL asked for S256 PKCE and the token exchange sent the verifier.
    const exchange = stub.calls.filter((c) => c.path === '/login/oauth/access_token').at(-1)!;
    expect(exchange.body).toMatchObject({
      client_id: APP.clientId,
      code_verifier: expect.any(String),
    });

    // Expiring soon → refreshed once (refresh tokens rotate).
    await prisma.githubAccount.update({
      where: { userId: user.id },
      data: { accessTokenExpiresAt: new Date(Date.now() + 60_000) },
    });
    const before = stub.calls.filter(
      (c) => (c.body as { grant_type?: string })?.grant_type === 'refresh_token',
    ).length;
    stub.install('cara-gh');
    const again = GithubAccountViewSchema.parse(
      keep(await as(user).get('/api/github/account')).body,
    );
    expect(again).toMatchObject({ connected: true, appInstalled: true });
    const after = stub.calls.filter(
      (c) => (c.body as { grant_type?: string })?.grant_type === 'refresh_token',
    ).length;
    expect(after).toBe(before + 1);
    const refreshed = await prisma.githubAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(refreshed.encryptedAccessToken).not.toBe(row.encryptedAccessToken);
    expect(refreshed.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 3600_000);

    // GitHub says 401 (token expired early) → one refresh, then it works.
    stub.expireTokens('cara-gh');
    const third = GithubAccountViewSchema.parse(
      keep(await as(user).get('/api/github/account')).body,
    );
    expect(third).toMatchObject({ connected: true, appInstalled: true });

    // Disconnect deletes the tokens.
    expect((await as(user).delete('/api/github/account')).status).toBe(204);
    expect(await prisma.githubAccount.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses a bad, used or someone else’s state', async () => {
    const user = await signUp('Sam State');
    const other = await signUp('Olly Other');
    stub.nextLogin = 'sam-gh';
    const start = await as(user).post('/api/github/connect/start');
    const back = await stub.login(start.body.url);
    const code = back.searchParams.get('code')!;
    const state = back.searchParams.get('state')!;
    expectError(
      await as(other).post('/api/github/connect/finish', { code, state }),
      400,
      'invalid_state',
    );
    expectError(
      await as(user).post('/api/github/connect/finish', { code, state: 'nope' }),
      400,
      'invalid_state',
    );
    expect((await as(user).post('/api/github/connect/finish', { code, state })).status).toBe(200);
    expectError(
      await as(user).post('/api/github/connect/finish', { code, state }),
      400,
      'invalid_state',
    );
    // An expired state.
    const start2 = await as(user).post('/api/github/connect/start');
    const back2 = await stub.login(start2.body.url);
    await prisma.githubOAuthState.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expectError(
      await as(user).post('/api/github/connect/finish', {
        code: back2.searchParams.get('code'),
        state: back2.searchParams.get('state'),
      }),
      400,
      'invalid_state',
    );
  });

  it('forgets a sign-in GitHub no longer accepts', async () => {
    const user = await signUp('Rita Revoked');
    await connect(user, 'rita-gh');
    await prisma.githubAccount.update({
      where: { userId: user.id },
      data: { accessTokenExpiresAt: new Date(Date.now() - 1000), encryptedRefreshToken: null },
    });
    const view = GithubAccountViewSchema.parse((await as(user).get('/api/github/account')).body);
    expect(view.connected).toBe(false);
    expect(await prisma.githubAccount.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('private commit emails', () => {
  it('uses DevSpace noreply addresses, and GitHub ones once connected', async () => {
    const w = await world();
    // Setup commit (template/empty) by a leader without GitHub.
    const first = await git(w.gitDir, ['log', '--reverse', '--format=%an <%ae>|%cn <%ce>', 'main']);
    expect(first.split('\n')[0]).toBe(
      `Lena Leader <${w.leader.id}@users.noreply.devspace.invalid>|Lena Leader <${w.leader.id}@users.noreply.devspace.invalid>`,
    );
    await connect(w.leader, 'lena-gh');
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n',
    );
    const sub = await submit(w, w.ann, ['src/a.ts']);
    await approve(w, sub.id);
    expect((await merge(w, sub.id)).status).toBe(200);
    const merged = await git(w.gitDir, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']);
    expect(merged.trim()).toBe(
      `Ann Author <${w.ann.id}@users.noreply.devspace.invalid>|Lena Leader <${stub.userId('lena-gh')}+lena-gh@users.noreply.github.com>`,
    );
    // The submission snapshot too.
    const snap = await git(w.gitDir, [
      'log',
      '-1',
      '--format=%ae',
      `refs/submissions/${sub.id}/v1`,
    ]);
    expect(snap.trim()).toBe(`${w.ann.id}@users.noreply.devspace.invalid`);
    expect((await revert(w, sub.id)).status).toBe(200);
    const reverted = await git(w.gitDir, ['log', '-1', '--format=%ae|%ce', 'main']);
    const gh = `${stub.userId('lena-gh')}+lena-gh@users.noreply.github.com`;
    expect(reverted.trim()).toBe(`${gh}|${gh}`);
    // The email warning: only the test's own commit has a real address ("Test Bot").
    const view = await projectView(w.leader, w.projectId);
    expect(view.emailWarning.names).toEqual(['Test Bot']);
    expect(JSON.stringify(view)).not.toContain('example.test');
    // Members who can't publish don't get the names.
    expect((await projectView(w.ann, w.projectId)).emailWarning.names).toEqual([]);
  });
});

describe('publish and keep updated', () => {
  it('publishes the full history privately, keeps GitHub updated and pauses on outside changes', async () => {
    const w = await world();
    const leader = w.leader;
    const login = 'lead-pub';
    // Not connected yet.
    expectError(
      await as(leader).post(url(w, '/github/publish'), {
        name: 'merge-project',
        mode: 'keep_updated',
        acceptEmailWarning: true,
      }),
      409,
      'github_not_connected',
    );
    await connect(leader, login);
    // Not installed yet.
    const notInstalled = await as(leader).post(url(w, '/github/publish'), {
      name: 'merge-project',
      mode: 'keep_updated',
      acceptEmailWarning: true,
    });
    expectError(notInstalled, 409, 'app_not_installed');
    expect(notInstalled.body.details.installUrl).toBe(
      `${stub.url}/apps/devspace-test/installations/new`,
    );
    stub.install(login, 'selected');
    // The email warning must be accepted (the test's commit has a real address).
    const warn = await as(leader).post(url(w, '/github/publish'), {
      name: 'merge-project',
      mode: 'keep_updated',
    });
    expectError(warn, 409, 'email_warning_not_accepted');
    expect(warn.body.details.names).toEqual(['Test Bot']);
    // Plain members can't publish.
    expectError(
      await as(w.ann).post(url(w, '/github/publish'), {
        name: 'merge-project',
        mode: 'keep_updated',
        acceptEmailWarning: true,
      }),
      403,
      'forbidden',
    );
    expect((await projectView(w.ann, w.projectId)).canPublish).toBe(false);
    // A bad name is refused before GitHub is asked.
    expectError(
      await as(leader).post(url(w, '/github/publish'), { name: 'bad name', mode: 'keep_updated' }),
      400,
      'validation_error',
    );

    const res = keep(
      await as(leader).post(url(w, '/github/publish'), {
        name: 'merge-project',
        mode: 'keep_updated',
        acceptEmailWarning: true,
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const published = ProjectGithubViewSchema.parse(res.body);
    expect(published.link).toMatchObject({
      repoFullName: `${login}/merge-project`,
      private: true,
      mode: 'keep_updated',
      status: 'pushing',
      htmlUrl: `${stub.url}/${login}/merge-project`,
    });
    expect(published.canPublish).toBe(false);
    expect(stub.repo(`${login}/merge-project`)!.private).toBe(true);
    // The new repository was added to the 'selected' installation.
    expect(
      stub.calls.some((c) => c.method === 'PUT' && c.path.includes('/user/installations/')),
    ).toBe(true);
    expect(takeQueuedGithubSyncs()).toEqual([w.projectId]);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: w.projectId } });
    expect((project.settings as { githubMode: string }).githubMode).toBe('keep_updated');

    // The worker's push: the full history arrives.
    expect(await runGithubSync(w.projectId)).toBe('ok');
    const ghMain = await stub.mainOf(`${login}/merge-project`);
    expect(ghMain).toBe(await mainSha(w.gitDir));
    const repoDir = stub.repo(`${login}/merge-project`)!.dir;
    expect(await git(repoDir, ['rev-list', '--count', 'main'])).toBe(
      await git(w.gitDir, ['rev-list', '--count', 'main']),
    );
    let view = await projectView(leader, w.projectId);
    expect(view.link).toMatchObject({ status: 'ok', lastPushedSha: ghMain, behind: false });
    // The push used an installation token in a Basic header, never force.
    expect(stub.pushes.at(-1)).toMatchObject({ fastForward: true });
    expect(stub.pushes.at(-1)!.auth).toMatch(/^Basic /);

    // Publishing again is refused; the same name in another project is taken.
    expectError(
      await as(leader).post(url(w, '/github/publish'), {
        name: 'other',
        mode: 'keep_updated',
        acceptEmailWarning: true,
      }),
      409,
      'already_published',
    );
    const second = await readyProject(leader, 'Second');
    expectError(
      await as(leader).post(`/api/projects/${second.projectId}/github/publish`, {
        name: 'merge-project',
        mode: 'publish_once',
      }),
      409,
      'repo_exists',
    );

    // A merge pushes main again (keep updated).
    write(w.annCopy, 'src/b.ts', 'export const b = 20;\n');
    const sub = await submit(w, w.ann, ['src/b.ts']);
    await approve(w, sub.id);
    expect((await merge(w, sub.id)).status).toBe(200);
    expect(takeQueuedGithubSyncs()).toEqual([w.projectId]);
    expect((await projectView(leader, w.projectId)).link!.status).toBe('pushing');
    expect(await runGithubSync(w.projectId)).toBe('ok');
    expect(await stub.mainOf(`${login}/merge-project`)).toBe(await mainSha(w.gitDir));

    // Someone changes the repository on GitHub → the next merge pauses, GitHub's history stays.
    const outside = await stub.commitOnGithub(`${login}/merge-project`, {
      'NOTE.md': 'from GitHub\n',
    });
    write(w.annCopy, 'src/a.ts', 'export const a = 7;\nexport const b = 2;\nexport const c = 3;\n');
    const sub2 = await submit(w, w.ann, ['src/a.ts'], 'Second change');
    await approve(w, sub2.id);
    expect((await merge(w, sub2.id)).status).toBe(200);
    expect(takeQueuedGithubSyncs()).toEqual([w.projectId]);
    const pushesBefore = stub.pushes.length;
    expect(await runGithubSync(w.projectId)).toBe('paused');
    expect(await stub.mainOf(`${login}/merge-project`)).toBe(outside);
    expect(stub.pushes.length).toBe(pushesBefore); // rejected before anything was sent
    view = await projectView(leader, w.projectId);
    expect(view.link).toMatchObject({
      status: 'paused',
      statusReason: 'GitHub has changes made outside DevSpace',
      behind: true,
    });
    // Leaders are told; activity is written.
    const notes = await prisma.notification.findMany({
      where: { projectId: w.projectId, type: 'github.sync_paused' },
    });
    expect(notes.map((n) => n.userId)).toEqual([leader.id]);
    expect(
      await prisma.activityLog.count({
        where: { projectId: w.projectId, action: 'github.sync_paused' },
      }),
    ).toBe(1);
    // Paused links aren't pushed by later merges or housekeeping.
    write(w.annCopy, 'docs/c.md', 'More docs\n');
    const sub3 = await submit(w, w.ann, ['docs/c.md'], 'Third');
    await approve(w, sub3.id);
    expect((await merge(w, sub3.id)).status).toBe(200);
    expect(takeQueuedGithubSyncs()).toEqual([]);
    const hk = await runHousekeeping({ copyIds: [], projectIds: [w.projectId] });
    expect(hk.githubRetried).toEqual([]);
    // Try again: members without the permission can't; the lead can, and it pauses again.
    expectError(await as(w.ann).post(url(w, '/github/sync')), 403, 'forbidden');
    const retry = keep(await as(leader).post(url(w, '/github/sync')));
    expect(retry.status).toBe(202);
    expect(ProjectGithubViewSchema.parse(retry.body).link!.status).toBe('pushing');
    expectError(await as(leader).post(url(w, '/github/sync')), 409, 'sync_running');
    expect(await runGithubSync(w.projectId)).toBe('paused');
    expect(await stub.mainOf(`${login}/merge-project`)).toBe(outside);
    // No push was ever a forced one.
    expect(stub.pushes.every((p) => p.fastForward)).toBe(true);

    // Unlink: members can't; the lead can; the repo stays on GitHub.
    expectError(await as(w.ann).delete(url(w, '/github'), {}), 403, 'forbidden');
    expect((await as(leader).delete(url(w, '/github'), {})).status).toBe(204);
    expect((await projectView(leader, w.projectId)).link).toBeNull();
    expect(stub.repo(`${login}/merge-project`)).toBeDefined();
    expectError(await as(leader).delete(url(w, '/github'), {}), 409, 'not_published');
    expectError(await as(leader).post(url(w, '/github/sync')), 409, 'not_published');
  });

  it('publish once: public when asked, members with the permission, no push after merges, retries failures', async () => {
    const leader = await signUp('Pia Publish');
    const { projectId, gitDir } = await readyProject(leader, 'Pia App');
    const helper = await signUp('Hal Helper');
    await addMember(leader, projectId, helper);
    await setPermissions(leader, projectId, helper, { publishGithub: true });
    await connect(helper, 'hal-gh');
    stub.install('hal-gh', 'all');
    // Setup commits are private already: no warning needed.
    expect((await projectView(helper, projectId)).emailWarning.names).toEqual([]);
    const res = keep(
      await as(helper).post(`/api/projects/${projectId}/github/publish`, {
        name: 'pia-app',
        private: false,
        mode: 'publish_once',
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(stub.repo('hal-gh/pia-app')!.private).toBe(false);
    expect(ProjectGithubViewSchema.parse(res.body).link).toMatchObject({
      private: false,
      mode: 'publish_once',
    });
    // An 'all' installation needs no PUT.
    expect(stub.calls.some((c) => c.method === 'PUT' && c.path.includes('hal'))).toBe(false);
    takeQueuedGithubSyncs();

    // A failure → failed (leaders told once), then housekeeping retries it.
    stub.failNext.set('POST /api/v3/app/installations', 500);
    expect(await runGithubSync(projectId)).toBe('failed');
    let view = await projectView(leader, projectId);
    expect(view.link!.status).toBe('failed');
    expect(view.link!.statusReason).toMatch(/try again/i);
    expect(view.canUnlink).toBe(true);
    expect((await projectView(helper, projectId)).canUnlink).toBe(false);
    const notes = await prisma.notification.findMany({
      where: { projectId, type: 'github.sync_failed' },
    });
    expect(notes.map((n) => n.userId)).toEqual([leader.id]);
    const hk = await runHousekeeping({ copyIds: [], projectIds: [projectId] });
    expect(hk.githubRetried).toEqual([projectId]);
    view = await projectView(leader, projectId);
    expect(view.link!.status).toBe('ok');
    expect(await stub.mainOf('hal-gh/pia-app')).toBe(await mainSha(gitDir));

    // Publish once: a new commit on main isn't pushed automatically.
    await commitFiles(gitDir, { 'index.html': '<p>new</p>\n' }, 'Direct test commit\n');
    const { afterMainMovedGithub } = await import('../src/github/link.ts');
    await afterMainMovedGithub(projectId);
    expect(takeQueuedGithubSyncs()).toEqual([]);
    expect((await projectView(leader, projectId)).link!.behind).toBe(true);
    // Switching the setting to keep updated pushes at once.
    const w = { projectId, leader } as Parameters<typeof setSettings>[0];
    await setSettings(w, { githubMode: 'keep_updated' });
    expect(takeQueuedGithubSyncs()).toEqual([projectId]);
    expect((await projectView(leader, projectId)).link!.mode).toBe('keep_updated');
    expect(await runGithubSync(projectId)).toBe('ok');
    expect(await stub.mainOf('hal-gh/pia-app')).toBe(await mainSha(gitDir));
  });
});

describe('import from GitHub', () => {
  it('lists reachable repositories and imports a private one', async () => {
    const leader = await signUp('Ivy Import');
    await connect(leader, 'ivy-gh');
    stub.install('ivy-gh', 'selected');
    const repo = await stub.createRepo('ivy-gh', 'secret-app', {
      private: true,
      files: { 'README.md': '# Secret\n', 'src/x.js': 'console.log(1);\n' },
    });
    await stub.createRepo('someone-else', 'not-mine', { private: true, files: { 'a.txt': 'a\n' } });
    const list = GithubRepoListResponseSchema.parse(
      keep(await as(leader).get('/api/github/repos')).body,
    );
    expect(list.repos.map((r) => r.fullName)).toEqual(['ivy-gh/secret-app']);
    expect(list.repos[0]).toMatchObject({ private: true, defaultBranch: 'main' });

    const team = await createTeam(leader);
    const project = await createProject(leader, team.id, 'Imported');
    const member = await signUp('Max Member');
    await addMember(leader, project.id, member);
    expectError(
      await as(member).post(`/api/projects/${project.id}/repository`, {
        source: 'github',
        repoFullName: 'ivy-gh/secret-app',
      }),
      403,
      'forbidden',
    );
    expectError(
      await as(leader).post(`/api/projects/${project.id}/repository`, {
        source: 'github',
        repoFullName: 'someone-else/not-mine',
      }),
      404,
      'github_repo_not_found',
    );
    const res = await as(leader).post(`/api/projects/${project.id}/repository`, {
      source: 'github',
      repoFullName: 'ivy-gh/secret-app',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await waitForImports();
    const status = await as(leader).get(`/api/projects/${project.id}/repository`);
    expect(status.body.repository).toMatchObject({
      status: 'ready',
      source: 'github',
      importUrl: `${stub.url}/ivy-gh/secret-app`,
    });
    const gitDir = (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
      .repoPath!;
    expect(await mainSha(gitDir)).toBe(await stub.mainOf('ivy-gh/secret-app'));
    // Not linked for syncing until published; no token or remote left in the repository.
    expect((await projectView(leader, project.id)).link).toBeNull();
    const config = readFileSync(join(gitDir, 'config'), 'utf8');
    expect(config).not.toMatch(/remote|extraheader|x-access-token/i);
    expect(repo.private).toBe(true);
  });
});
