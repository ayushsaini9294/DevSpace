import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  CopyResponseSchema,
  GettingStartedViewSchema,
  IdeLaunchResponseSchema,
  RepositoryResponseSchema,
  TEMPLATE_IDS,
  TEMPLATES,
  TemplateListSchema,
  type CopyView,
  type GettingStartedView,
  type TemplateId,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { copyDir } from '../src/copies/service.ts';
import {
  initBare,
  lastCommit,
  listAllFiles,
  listTreeObject,
  MAIN_REF,
  readBlob,
} from '../src/git/repo.ts';
import { createIdeServer, parsePreviewPath, previewNext } from '../src/ide/proxy.ts';
import { setIdeTargetForTests } from '../src/ide/service.ts';
import { prisma } from '../src/lib/prisma.ts';
import { templateDir, writeFolderTree } from '../src/repository/templates.ts';
import {
  addMember,
  app,
  as,
  cleanUp,
  createProject,
  createTeam,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';

// ---------- Set-up ----------

/** The IDE site, listening on a free local port (like the second listener in index.ts). */
let ideServer: Server;

/**
 * A stand-in for a member's app running inside their container: it echoes what it received,
 * tries to set a cookie and other headers the proxy must drop, and accepts WebSockets.
 */
let appServer: Server;
let appPort: number;
const seenUpgrades: IncomingHttpHeaders[] = [];
const sockets = new Set<net.Socket>();

/** A port nothing listens on (bound once, then closed). */
let closedPort: number;

beforeAll(async () => {
  ideServer = createIdeServer();
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));

  appServer = createServer((req, res) => {
    const body = JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null });
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': ['stolen=1; Path=/', 'devspace_ide=evil; Path=/'],
      'x-frame-options': 'DENY',
      'clear-site-data': '"cookies"',
      'x-app': 'yes',
    });
    res.end(body);
  });
  appServer.on('upgrade', (req, socket) => {
    seenUpgrades.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => socket.destroy());
  });
  for (const server of [ideServer, appServer]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  }
  await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  appPort = (appServer.address() as AddressInfo).port;

  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
});

afterAll(async () => {
  for (const server of [ideServer, appServer]) {
    // Upgraded (WebSocket) sockets aren't HTTP connections any more, so end them by hand.
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await cleanUp();
});

const ide = () => request(ideServer);
const api = (projectId: string, path: string) => `/api/projects/${projectId}${path}`;

async function newProject(template: TemplateId | null = 'empty', name = 'Beginner Project') {
  const leader = await signUp('Lea Leader');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, name);
  if (template) await setUp(leader, project.id, template);
  return { leader, project };
}

async function setUp(user: TestUser, projectId: string, template: TemplateId) {
  const res = await as(user).post(api(projectId, '/repository'), { source: 'template', template });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return RepositoryResponseSchema.parse(res.body).repository;
}

async function repoPathOf(projectId: string): Promise<string> {
  const row = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { repoPath: true },
  });
  return row.repoPath!;
}

/** Every file under `folder`: relative path → { bytes, executable }. */
async function folderFiles(folder: string, prefix = '') {
  const out = new Map<string, { bytes: Buffer; executable: boolean }>();
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const info = await lstat(path);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (info.isDirectory()) {
      for (const [k, v] of await folderFiles(path, rel)) out.set(k, v);
    } else {
      out.set(rel, { bytes: await readFile(path), executable: (info.mode & 0o111) !== 0 });
    }
  }
  return out;
}

/** A copy for `user` whose IDE counts as running, with the proxy pointed at our stand-in. */
async function runningCopy(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).post(api(projectId, '/copy'));
  expect([200, 201]).toContain(res.status);
  const copy = CopyResponseSchema.parse(res.body).copy!;
  await prisma.copy.update({ where: { id: copy.id }, data: { containerStatus: 'running' } });
  setIdeTargetForTests(copy.id, { ip: '127.0.0.1', token: 'test-token-not-for-apps' });
  return copy;
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
}

/** POST …/preview/launch as `user` → the launch URL (on the IDE site). */
async function previewLaunch(user: TestUser, path: string, port: number): Promise<URL> {
  const res = await as(user).post(path, { port });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const url = new URL(IdeLaunchResponseSchema.parse(res.body).url);
  expect(url.origin).toBe(env.IDE_ORIGIN);
  expect(url.pathname).toBe('/ide-launch');
  return url;
}

/** Follows a launch URL on the IDE site; returns the redirect and the `devspace_ide` pair. */
async function redeem(url: URL) {
  const res = await ide().get(`${url.pathname}${url.search}`);
  expect(res.status, res.text).toBe(303);
  const cookie = setCookies(res).find((c) => c.startsWith('devspace_ide='));
  expect(cookie).toBeDefined();
  return { location: res.headers.location as string, cookie: cookie!.split(';')[0]! };
}

/** Sends a raw WebSocket upgrade and returns the status line the server answers with. */
async function upgradeStatus(path: string, headers: Record<string, string>): Promise<string> {
  const { port } = ideServer.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    socket.setTimeout(20_000, () => {
      socket.destroy();
      reject(new Error(`no answer to the upgrade (got: ${data})`));
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      const end = data.indexOf('\r\n');
      if (end >= 0) {
        socket.destroy();
        resolve(data.slice(0, end));
      }
    });
    socket.on('error', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

const frameAncestors = () => `frame-ancestors 'self' ${env.APP_ORIGIN}`;

function expectFramePolicy(res: request.Response) {
  const csp = res.headers['content-security-policy'] as string | string[] | undefined;
  expect([csp].flat().join(', ')).toContain(frameAncestors());
}

// ---------- Templates ----------

describe('GET /api/templates', () => {
  it('needs a login, then lists the six templates in order', async () => {
    expect((await request(app).get('/api/templates')).status).toBe(401);
    const user = await signUp('Tim Templates');
    const res = await as(user).get('/api/templates');
    expect(res.status).toBe(200);
    const list = TemplateListSchema.parse(res.body);
    expect(list.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(list).toEqual(TEMPLATES);
    expect(list.find((t) => t.id === 'html')!.previewPort).toBe(8080);
    expect(list.find((t) => t.id === 'python')!.previewPort).toBeNull();
    // Port 3000 belongs to VS Code in the container; no template may use it.
    expect(list.every((t) => t.previewPort !== 3000)).toBe(true);
  });
});

describe('setting up a repository from a template', () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id}: main has exactly the template's files, as one commit by the leader`, async () => {
      const { leader, project } = await newProject(null, `From ${id}`);
      const repository = await setUp(leader, project.id, id);
      expect(repository.status).toBe('ready');
      expect(repository.source).toBe('template');
      expect(repository.template).toBe(id);
      const name = TEMPLATES.find((t) => t.id === id)!.name;
      expect(repository.lastCommit?.message).toBe(`Start from the ${name} template`);
      expect(repository.lastCommit?.authorName).toBe(leader.name);

      const gitDir = await repoPathOf(project.id);
      const head = (await lastCommit(gitDir, MAIN_REF))!;
      expect(head.authorEmail).toBe(leader.email);
      const inMain = await listAllFiles(gitDir, head.sha);
      const onDisk = await folderFiles(templateDir(id));
      expect(inMain.map((f) => f.path).sort()).toEqual([...onDisk.keys()].sort());
      for (const file of inMain) {
        const disk = onDisk.get(file.path)!;
        expect(file.mode, file.path).toBe(disk.executable ? '100755' : '100644');
        const bytes = await readBlob(gitDir, file.sha, 10 * 1024 * 1024);
        expect(bytes.equals(disk.bytes), file.path).toBe(true);
      }
      // Every template has a README and the agreed .gitignore.
      expect(onDisk.has('README.md')).toBe(true);
      const ignore = onDisk.get('.gitignore')!.bytes.toString('utf8');
      for (const line of ['node_modules/', 'dist/', '.env', '__pycache__/', '.venv/']) {
        expect(ignore.split('\n')).toContain(line);
      }

      const again = await as(leader).post(api(project.id, '/repository'), {
        source: 'template',
        template: id,
      });
      expectError(again, 409, 'repository_exists');
    });
  }

  it('keeps executable modes and skips empty folders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devspace-template-test-'));
    try {
      const folder = join(dir, 'tpl');
      await mkdir(join(folder, 'bin'), { recursive: true });
      await mkdir(join(folder, 'empty'), { recursive: true });
      await writeFile(join(folder, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
      await chmod(join(folder, 'bin', 'run.sh'), 0o755);
      await writeFile(join(folder, 'plain.txt'), 'hello\n');
      const gitDir = join(dir, 'repo.git');
      await initBare(gitDir);
      const tree = (await writeFolderTree(gitDir, folder))!;
      const top = await listTreeObject(gitDir, tree);
      expect(top.map((e) => e.name).sort()).toEqual(['bin', 'plain.txt']);
      expect(top.find((e) => e.name === 'plain.txt')!.mode).toBe('100644');
      const bin = await listTreeObject(gitDir, top.find((e) => e.name === 'bin')!.sha);
      expect(bin).toMatchObject([{ name: 'run.sh', mode: '100755' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown template and non-leaders', async () => {
    const { leader, project } = await newProject(null);
    const bad = await as(leader).post(api(project.id, '/repository'), {
      source: 'template',
      template: 'cobol',
    });
    expectError(bad, 400, 'validation_error');
    const member = await signUp('Mo Member');
    await addMember(leader, project.id, member);
    const res = await as(member).post(api(project.id, '/repository'), {
      source: 'template',
      template: 'html',
    });
    expectError(res, 403, 'forbidden');
  });

  it('an empty set-up still reports no template', async () => {
    const { leader, project } = await newProject(null);
    const res = await as(leader).post(api(project.id, '/repository'), { source: 'empty' });
    const repository = RepositoryResponseSchema.parse(res.body).repository;
    expect(repository.source).toBe('empty');
    expect(repository.template).toBeNull();
  });
});

// ---------- Preview ----------

describe('preview helpers', () => {
  it('accept only 1024–65535 except 3000, written plainly', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const p = (rest: string) => parsePreviewPath(`/ide/${id}/__preview/${rest}`, id);
    expect(p('8080/')).toEqual({ port: 8080, bare: false });
    expect(p('5173/src/main.jsx')).toEqual({ port: 5173, bare: false });
    expect(p('8080')).toEqual({ port: 8080, bare: true });
    for (const bad of ['3000/', '80/', '1023/', '65536/', '08080/', 'abc/', '/', '-1/']) {
      expect(p(bad)?.port ?? null, bad).toBeNull();
    }
    expect(parsePreviewPath(`/ide/${id}/other`, id)).toBeNull();
    expect(previewNext('__preview/8080/')).toBe('__preview/8080/');
    for (const bad of [
      '__preview/3000/',
      '__preview/8080',
      '__preview/8080/x',
      '../__preview/8080/',
      'https://evil.example/',
      '//evil.example/',
      '',
    ]) {
      expect(previewNext(bad), bad).toBeNull();
    }
  });
});

describe('POST /copy/preview/launch', () => {
  it('needs a copy, a running IDE and an allowed port; records previewedAt', async () => {
    const { leader, project } = await newProject();
    const path = api(project.id, '/copy/preview/launch');
    expectError(await as(leader).post(path, { port: 8080 }), 404, 'not_found');
    const outsider = await signUp('Olly Outsider');
    expectError(await as(outsider).post(path, { port: 8080 }), 404, 'not_found');

    const created = await as(leader).post(api(project.id, '/copy'));
    expect(created.status).toBe(201);
    expectError(await as(leader).post(path, { port: 8080 }), 409, 'ide_not_running');

    await runningCopy(leader, project.id);
    for (const port of [3000, 80, 70000, 8080.5]) {
      expectError(await as(leader).post(path, { port }), 400, 'validation_error');
    }
    expectError(await as(leader).post(path, {}), 400, 'validation_error');

    const url = await previewLaunch(leader, path, 8080);
    expect(url.toString()).toMatch(/&next=__preview\/8080\/$/);
    const row = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: leader.id } },
      select: { previewedAt: true },
    });
    expect(row.previewedAt).not.toBeNull();
  });
});

describe('/ide-launch with next', () => {
  it('accepts only __preview/<port>/, and a refused next does not use the ticket up', async () => {
    const { leader, project } = await newProject();
    const copy = await runningCopy(leader, project.id);
    const res = await as(leader).post(api(project.id, '/copy/ide/launch'));
    const ticket = new URL(IdeLaunchResponseSchema.parse(res.body).url).searchParams.get('ticket')!;
    const t = encodeURIComponent(ticket);
    for (const next of [
      'https://evil.example/',
      '//evil.example/',
      '__preview/3000/',
      '__preview/99/',
      '__preview/8080',
      '../../x',
      '',
    ]) {
      const bad = await ide().get(`/ide-launch?ticket=${t}&next=${encodeURIComponent(next)}`);
      expect(bad.status, next).toBe(404);
      expect(setCookies(bad)).toEqual([]);
    }
    const good = await ide().get(`/ide-launch?ticket=${t}&next=__preview/5173/`);
    expect(good.status).toBe(303);
    expect(good.headers.location).toBe(`/ide/${copy.id}/__preview/5173/`);
    // Used once.
    expect((await ide().get(`/ide-launch?ticket=${t}&next=__preview/5173/`)).status).toBe(404);
  });
});

describe('the preview proxy', () => {
  it("forwards the full path to the member's app, with no credentials and no app cookies", async () => {
    const { leader, project } = await newProject();
    const copy = await runningCopy(leader, project.id);
    const launch = await previewLaunch(leader, api(project.id, '/copy/preview/launch'), appPort);
    const { location, cookie } = await redeem(launch);
    expect(location).toBe(`/ide/${copy.id}/__preview/${appPort}/`);

    const path = `/ide/${copy.id}/__preview/${appPort}/hello/world.js?x=1`;
    const res = await ide()
      .get(path)
      .set('Cookie', `${cookie}; other=1`)
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(200);
    expect(res.headers['x-app']).toBe('yes');
    expect(JSON.parse(res.text)).toEqual({ url: path, cookie: null });
    expect(setCookies(res)).toEqual([]);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['clear-site-data']).toBeUndefined();
    expectFramePolicy(res);

    // No slash after the port: redirected to add it (keeping the query).
    const bare = await ide().get(`/ide/${copy.id}/__preview/${appPort}?q=2`).set('Cookie', cookie);
    expect(bare.status).toBe(308);
    expect(bare.headers.location).toBe(`/ide/${copy.id}/__preview/${appPort}/?q=2`);
  });

  it('refuses port 3000, out-of-range ports, no cookie, and other copies', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Mia Member');
    await addMember(leader, project.id, member);
    const copy = await runningCopy(leader, project.id);
    const other = await runningCopy(member, project.id);
    const { cookie } = await redeem(
      await previewLaunch(leader, api(project.id, '/copy/preview/launch'), appPort),
    );
    const { cookie: memberCookie } = await redeem(
      await previewLaunch(member, api(project.id, '/copy/preview/launch'), appPort),
    );

    const at = (port: string | number, id = copy.id) => `/ide/${id}/__preview/${port}/`;
    for (const port of [3000, 80, 1023, 65536, 99999, '0080', 'abc']) {
      const res = await ide().get(at(port)).set('Cookie', cookie);
      expect(res.status, String(port)).toBe(404);
    }
    expect((await ide().get(at(appPort))).status).toBe(404);
    // The member's IDE cookie is for their own copy only.
    expect((await ide().get(at(appPort)).set('Cookie', memberCookie)).status).toBe(404);
    expect((await ide().get(at(appPort, other.id)).set('Cookie', memberCookie)).status).toBe(200);
    // A lead's cookie for their own copy doesn't open the member's copy either.
    expect((await ide().get(at(appPort, other.id)).set('Cookie', cookie)).status).toBe(404);

    // Once the member leaves, their cookie stops working.
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: project.id, userId: member.id } },
    });
    expect((await ide().get(at(appPort, other.id)).set('Cookie', memberCookie)).status).toBe(404);
  });

  it('says plainly when nothing is running on the port', async () => {
    const { leader, project } = await newProject();
    const copy = await runningCopy(leader, project.id);
    const { cookie } = await redeem(
      await previewLaunch(leader, api(project.id, '/copy/preview/launch'), closedPort),
    );
    const res = await ide().get(`/ide/${copy.id}/__preview/${closedPort}/`).set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toContain(`Nothing is running on port ${closedPort} yet`);
    expect(res.text).toContain('README');
    expectFramePolicy(res);
  });

  it('proxies WebSockets (for live reload) from the IDE site only', async () => {
    const { leader, project } = await newProject();
    const copy = await runningCopy(leader, project.id);
    const { cookie } = await redeem(
      await previewLaunch(leader, api(project.id, '/copy/preview/launch'), appPort),
    );
    const ws = `/ide/${copy.id}/__preview/${appPort}/ws?token=abc`;
    const before = seenUpgrades.length;
    expect(await upgradeStatus(ws, { Cookie: cookie, Origin: env.IDE_ORIGIN })).toMatch(
      /^HTTP\/1\.1 101/,
    );
    expect(seenUpgrades.length).toBe(before + 1);
    // The app gets no cookie at all (not VS Code's token either).
    expect(seenUpgrades.at(-1)!.cookie).toBeUndefined();

    expect(await upgradeStatus(ws, { Cookie: cookie, Origin: env.APP_ORIGIN })).toMatch(/ 403/);
    expect(await upgradeStatus(ws, { Cookie: cookie })).toMatch(/ 403/);
    expect(await upgradeStatus(ws, { Origin: env.IDE_ORIGIN })).toMatch(/ 404/);
    expect(
      await upgradeStatus(`/ide/${copy.id}/__preview/3000/`, {
        Cookie: cookie,
        Origin: env.IDE_ORIGIN,
      }),
    ).toMatch(/ 404/);
    expect(
      await upgradeStatus(`/ide/${copy.id}/__preview/${closedPort}/`, {
        Cookie: cookie,
        Origin: env.IDE_ORIGIN,
      }),
    ).toMatch(/ 502/);
  });

  it("a lead may preview a member's copy (logged); a plain member may not", async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Max Member');
    const peer = await signUp('Pat Peer');
    await addMember(leader, project.id, member);
    await addMember(leader, project.id, peer);
    const copy = await runningCopy(member, project.id);

    const leadPath = api(project.id, `/members/${member.id}/copy/preview/launch`);
    expectError(await as(peer).post(leadPath, { port: appPort }), 403, 'forbidden');
    const { cookie, location } = await redeem(await previewLaunch(leader, leadPath, appPort));
    expect(location).toBe(`/ide/${copy.id}/__preview/${appPort}/`);
    const res = await ide().get(location).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const helped = await prisma.activityLog.count({
      where: { projectId: project.id, action: 'copy.helped', target: member.id },
    });
    expect(helped).toBe(1);

    // Demoted leads lose access at once (re-checked on every request): demote by editing
    // the row, since the only leader can't be demoted through the API.
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: project.id, userId: leader.id } },
      data: { role: 'member' },
    });
    expect((await ide().get(location).set('Cookie', cookie)).status).toBe(404);
  });
});

// ---------- Getting started ----------

async function steps(user: TestUser, projectId: string): Promise<GettingStartedView> {
  const res = await as(user).get(api(projectId, '/getting-started'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return GettingStartedViewSchema.parse(res.body);
}

const doneMap = (view: GettingStartedView) =>
  Object.fromEntries(view.steps.map((s) => [s.id, s.done]));

describe('the getting-started checklist', () => {
  it('ticks each step from real data, for leaders and members', async () => {
    const { leader, project } = await newProject(null);
    let view = await steps(leader, project.id);
    expect(view.hidden).toBe(false);
    expect(view.steps.map((s) => s.id)).toEqual([
      'setup',
      'invite',
      'openIde',
      'change',
      'preview',
      'submit',
      'reviewed',
    ]);
    expect(view.steps.every((s) => !s.done)).toBe(true);

    await setUp(leader, project.id, 'html');
    expect(doneMap(await steps(leader, project.id))).toMatchObject({ setup: true, invite: false });

    const invite = await as(leader).post(api(project.id, '/invitations'), {
      email: 'someone-new@example.test',
    });
    expect(invite.status).toBe(201);
    expect(doneMap(await steps(leader, project.id)).invite).toBe(true);

    const member = await signUp('Nia Newcomer');
    await addMember(leader, project.id, member);
    view = await steps(member, project.id);
    expect(view.steps.map((s) => s.id)).toEqual([
      'openIde',
      'change',
      'preview',
      'submit',
      'reviewed',
    ]);
    expect(view.steps.every((s) => !s.done)).toBe(true);

    // A copy alone isn't "opened the IDE"; a started container is (even once stopped).
    const made = await as(member).post(api(project.id, '/copy'));
    const copy = CopyResponseSchema.parse(made.body).copy!;
    expect(doneMap(await steps(member, project.id)).openIde).toBe(false);
    await prisma.copy.update({ where: { id: copy.id }, data: { containerStatus: 'stopped' } });
    expect(doneMap(await steps(member, project.id)).openIde).toBe(true);

    // A real change in the copy's files.
    const root = copyDir(project.id, copy.id);
    await writeFile(join(root, 'index.html'), '<h1>Changed by Nia</h1>\n');
    expect(doneMap(await steps(member, project.id))).toMatchObject({
      change: true,
      submit: false,
    });

    await runningCopy(member, project.id);
    await previewLaunch(member, api(project.id, '/copy/preview/launch'), 8080);
    expect(doneMap(await steps(member, project.id)).preview).toBe(true);

    const submitted = await as(member).post(api(project.id, '/submissions'), {
      title: 'My first change',
      description: '',
      paths: ['index.html'],
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const submissionId = submitted.body.submission.id as string;
    expect(doneMap(await steps(member, project.id))).toMatchObject({
      submit: true,
      change: true,
      reviewed: false,
    });

    // Their own comment doesn't count; a teammate's does.
    const own = await as(member).post(api(project.id, `/submissions/${submissionId}/comments`), {
      body: 'Note to self',
    });
    expect(own.status).toBe(201);
    expect(doneMap(await steps(member, project.id)).reviewed).toBe(false);
    const theirs = await as(leader).post(api(project.id, `/submissions/${submissionId}/comments`), {
      body: 'Nice first change!',
    });
    expect(theirs.status).toBe(201);
    view = await steps(member, project.id);
    expect(view.steps.every((s) => s.done)).toBe(true);

    // The leader's own steps are theirs: they haven't opened an IDE or submitted.
    expect(doneMap(await steps(leader, project.id))).toMatchObject({
      setup: true,
      invite: true,
      openIde: false,
      submit: false,
    });
  });

  it('hide and show are per member, and non-members get 404', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Hal Hider');
    await addMember(leader, project.id, member);

    const hidden = await as(member).post(api(project.id, '/getting-started/hide'));
    expect(hidden.status).toBe(200);
    expect(GettingStartedViewSchema.parse(hidden.body).hidden).toBe(true);
    expect((await steps(member, project.id)).hidden).toBe(true);
    expect((await steps(leader, project.id)).hidden).toBe(false);

    const shown = await as(member).post(api(project.id, '/getting-started/show'));
    expect(GettingStartedViewSchema.parse(shown.body).hidden).toBe(false);

    const outsider = await signUp('Out Sider');
    expectError(await as(outsider).get(api(project.id, '/getting-started')), 404, 'not_found');
    expectError(
      await as(outsider).post(api(project.id, '/getting-started/hide')),
      404,
      'not_found',
    );
  });
});
