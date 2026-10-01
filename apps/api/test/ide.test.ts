import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  CopyResponseSchema,
  IdeLaunchResponseSchema,
  RepositoryResponseSchema,
  SESSION_COOKIE_NAME,
  type CopyView,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { copyDir } from '../src/copies/service.ts';
import {
  containerName,
  docker,
  isNotFound,
  MEMORY_BYTES,
  NANO_CPUS,
  PIDS_LIMIT,
} from '../src/ide/docker.ts';
import { cookieValues, createIdeServer, forwardHeaders, parseIdePath } from '../src/ide/proxy.ts';
import { forgetIdeTarget, waitForIdeStarts } from '../src/ide/service.ts';
import { prisma } from '../src/lib/prisma.ts';
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

// ---------- What this machine can run ----------

async function probeDocker(): Promise<{ docker: boolean; ide: boolean; why: string }> {
  try {
    await docker.ping();
  } catch (err) {
    const why = `Docker isn't reachable at ${env.DOCKER_SOCKET} (${err instanceof Error ? err.message : err})`;
    return { docker: false, ide: false, why };
  }
  try {
    await docker.getImage(env.IDE_IMAGE).inspect();
  } catch {
    return {
      docker: true,
      ide: false,
      why: `image ${env.IDE_IMAGE} is missing (npm run ide:build)`,
    };
  }
  try {
    await docker.getNetwork(env.IDE_NETWORK).inspect();
  } catch {
    return {
      docker: true,
      ide: false,
      why: `network ${env.IDE_NETWORK} is missing (npm run ide:network)`,
    };
  }
  return { docker: true, ide: true, why: '' };
}

const available = await probeDocker();
if (!available.ide) {
  console.warn(`SKIPPING the real IDE container tests: ${available.why}`);
}

// ---------- Helpers ----------

const startedCopies = new Set<string>();

/** The IDE site, listening on a free local port (like the second listener in index.ts). */
let ideServer: Server;
/** The app, listening too, to show it has no WebSocket handling for /ide any more. */
let appServer: Server;
beforeAll(async () => {
  ideServer = createIdeServer();
  appServer = createServer(app);
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await waitForIdeStarts();
  if (available.docker) {
    for (const id of startedCopies) {
      await docker
        .getContainer(containerName(id))
        .remove({ force: true })
        .catch(() => undefined);
    }
  }
  ideServer.closeAllConnections();
  await new Promise((resolve) => ideServer.close(resolve));
  appServer.closeAllConnections();
  await new Promise((resolve) => appServer.close(resolve));
  await cleanUp();
});

const ide = () => request(ideServer);

async function newProject(name = 'IDE Project', { ready = true } = {}) {
  const leader = await signUp('Ida Leader');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, name);
  if (ready) {
    const res = await as(leader).post(`/api/projects/${project.id}/repository`, {
      source: 'empty',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(RepositoryResponseSchema.parse(res.body).repository.status).toBe('ready');
  }
  return { leader, project };
}

const ideApi = (projectId: string) => `/api/projects/${projectId}/copy/ide`;
const launchApi = (projectId: string) => `/api/projects/${projectId}/copy/ide/launch`;

async function openIde(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).post(ideApi(projectId));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const { copy } = CopyResponseSchema.parse(res.body);
  expect(copy).not.toBeNull();
  startedCopies.add(copy!.id);
  return copy!;
}

async function getCopy(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).get(`/api/projects/${projectId}/copy`);
  expect(res.status).toBe(200);
  return CopyResponseSchema.parse(res.body).copy!;
}

/** A copy with no container (POST /copy only). */
async function plainCopy(user: TestUser, projectId: string): Promise<CopyView> {
  const res = await as(user).post(`/api/projects/${projectId}/copy`);
  expect(res.status).toBe(201);
  return CopyResponseSchema.parse(res.body).copy!;
}

/**
 * Marks a copy `running` without a container, to test tickets and cookies on their own (the
 * proxy then answers 503, which shows the request got past every access check).
 */
async function markRunning(copyId: string) {
  await prisma.copy.update({ where: { id: copyId }, data: { containerStatus: 'running' } });
}

/** POST …/launch as `user`; returns the ticket from the URL. */
async function launchTicket(user: TestUser, projectId: string): Promise<string> {
  const res = await as(user).post(launchApi(projectId));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const { url } = IdeLaunchResponseSchema.parse(res.body);
  const parsed = new URL(url);
  expect(parsed.origin).toBe(env.IDE_ORIGIN);
  expect(parsed.pathname).toBe('/ide-launch');
  return parsed.searchParams.get('ticket')!;
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
}

/** Uses a ticket on the IDE site; returns the `devspace_ide=…` cookie pair and all Set-Cookies. */
async function redeem(ticket: string) {
  const res = await ide().get(`/ide-launch?ticket=${encodeURIComponent(ticket)}`);
  expect(res.status, res.text).toBe(303);
  const all = setCookies(res);
  const ideCookie = all.find((c) => c.startsWith('devspace_ide='))!;
  expect(ideCookie).toBeDefined();
  return { res, all, cookie: ideCookie.split(';')[0]! };
}

/** Sends a raw WebSocket upgrade and returns the status line the server answers with. */
async function upgradeStatus(
  server: Server,
  path: string,
  headers: Record<string, string>,
): Promise<string> {
  const { port } = server.address() as AddressInfo;
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

// ---------- Always: refusals, tickets, cookies ----------

describe('POST /copy/ide refusals', () => {
  it('non-members get 404 and no copy is made', async () => {
    const { project } = await newProject();
    const outsider = await signUp('Olly Outsider');
    expectError(await as(outsider).post(ideApi(project.id)), 404, 'not_found');
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("409 while the project's repository isn't ready", async () => {
    const { leader, project } = await newProject('No Repo', { ready: false });
    expectError(await as(leader).post(ideApi(project.id)), 409, 'repository_not_ready');
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('needs a login', async () => {
    const { project } = await newProject();
    const res = await request(app).post(ideApi(project.id)).set('Content-Type', 'application/json');
    expectError(res, 401, 'unauthenticated');
  });

  it('the copy view has no IDE link', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    expect(copy).not.toHaveProperty('ideUrl');
  });
});

describe('POST /copy/ide/launch', () => {
  it('404 without a copy or for non-members, 409 unless the IDE is running', async () => {
    const { leader, project } = await newProject();
    const outsider = await signUp('Olly Outsider');
    expectError(await as(leader).post(launchApi(project.id)), 404, 'not_found');
    const copy = await plainCopy(leader, project.id);
    expectError(await as(leader).post(launchApi(project.id)), 409, 'ide_not_running');
    await markRunning(copy.id);
    expectError(await as(outsider).post(launchApi(project.id)), 404, 'not_found');
    expectError(
      await request(app).post(launchApi(project.id)).set('Content-Type', 'application/json'),
      401,
      'unauthenticated',
    );
    expect(await prisma.ideTicket.count({ where: { copyId: copy.id } })).toBe(0);
  });

  it('returns a one-time URL on the IDE site; only its hash is stored', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    await markRunning(copy.id);
    const ticket = await launchTicket(leader, project.id);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const rows = await prisma.ideTicket.findMany({ where: { copyId: copy.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(createHash('sha256').update(ticket).digest('hex'));
    expect(rows[0]!.userId).toBe(leader.id);
    const ttl = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });
});

describe('the IDE site: tickets and its own cookie', () => {
  it('a ticket works once: the cookies, their scope, then a redirect into the IDE', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    await markRunning(copy.id);
    const ticket = await launchTicket(leader, project.id);

    const { res, cookie } = await redeem(ticket);
    expect(res.headers.location).toBe(`/ide/${copy.id}/`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expectFramePolicy(res);
    const ideCookie = setCookies(res).find((c) => c.startsWith('devspace_ide='))!;
    const attrs = ideCookie.split('; ').slice(1);
    expect(attrs).toEqual(
      expect.arrayContaining([
        `Path=/ide/${copy.id}/`,
        'Max-Age=43200',
        'HttpOnly',
        'Secure',
        'SameSite=None',
        'Partitioned',
      ]),
    );
    expect(cookie).toMatch(/^devspace_ide=[A-Za-z0-9_-]{43}$/);
    // Stored only as a hash, for this user and copy.
    const value = cookie.split('=')[1]!;
    const session = await prisma.ideSession.findUnique({
      where: { id: createHash('sha256').update(value).digest('hex') },
    });
    expect(session).toMatchObject({ userId: leader.id, copyId: copy.id });
    // No container here, so no vscode-tkn cookie either.
    expect(setCookies(res).some((c) => c.startsWith('vscode-tkn='))).toBe(false);

    // Used up.
    const again = await ide().get(`/ide-launch?ticket=${ticket}`);
    expect(again.status).toBe(404);
    expect(again.headers['content-type']).toMatch(/text\/plain/);
    expect(setCookies(again)).toEqual([]);
    expect(await prisma.ideTicket.count({ where: { copyId: copy.id } })).toBe(0);

    // The cookie gets past every check (503: no container behind this test copy).
    const through = await ide().get(`/ide/${copy.id}/`).set('Cookie', cookie);
    expect(through.status).toBe(503);
    expectFramePolicy(through);
  });

  it('refuses expired, unknown, missing and malformed tickets, and other methods', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    await markRunning(copy.id);
    const ticket = await launchTicket(leader, project.id);
    await prisma.ideTicket.updateMany({
      where: { copyId: copy.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await ide().get(`/ide-launch?ticket=${ticket}`)).status).toBe(404);
    // Expired tickets are used up too.
    expect(await prisma.ideTicket.count({ where: { copyId: copy.id } })).toBe(0);

    const fresh = await launchTicket(leader, project.id);
    expect((await ide().post(`/ide-launch?ticket=${fresh}`)).status).toBe(404);
    expect((await ide().get(`/ide-launch?ticket=${fresh}x`)).status).toBe(404);
    expect((await ide().get('/ide-launch')).status).toBe(404);
    expect((await ide().get('/ide-launch?ticket=')).status).toBe(404);
    expect((await ide().get(`/ide-launch?ticket=${'a'.repeat(5000)}`)).status).toBe(404);
    // The POST above didn't use it.
    await redeem(fresh);
  });

  it('a ticket stops working once its user leaves the project', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Lee Leaving');
    await addMember(leader, project.id, member);
    const copy = await plainCopy(member, project.id);
    await markRunning(copy.id);
    const ticket = await launchTicket(member, project.id);
    const res = await as(leader).delete(`/api/projects/${project.id}/members/${member.id}`);
    expect(res.status).toBe(204);
    expect((await ide().get(`/ide-launch?ticket=${ticket}`)).status).toBe(404);
  });

  it('only the IDE cookie of that copy opens it; everyone else gets the same 404', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Mo Member');
    await addMember(leader, project.id, member);
    const mine = await plainCopy(member, project.id);
    const theirs = await plainCopy(leader, project.id);
    await markRunning(mine.id);
    await markRunning(theirs.id);
    const { cookie } = await redeem(await launchTicket(member, project.id));
    const url = `/ide/${mine.id}/`;

    expect((await ide().get(url).set('Cookie', cookie)).status).toBe(503);
    // No cookie; the app's session cookie; an unknown value; my cookie on another copy.
    const refusals = [
      ide().get(url),
      ide().get(url).set('Cookie', member.cookie),
      ide()
        .get(url)
        .set('Cookie', `${member.cookie}; devspace_ide=${'x'.repeat(43)}`),
      ide().get(`/ide/${theirs.id}/`).set('Cookie', cookie),
      ide().get(`/ide/${crypto.randomUUID()}/`).set('Cookie', cookie),
      ide().post(url).set('Cookie', member.cookie),
      ide().get('/ide/not-a-copy/').set('Cookie', cookie),
      ide().get('/api/health'),
      ide().get('/'),
    ];
    for (const res of await Promise.all(refusals)) {
      expect(res.status, res.text).toBe(404);
      expect(res.text).toBe('Not found\n');
      expectFramePolicy(res);
    }

    // Without the trailing slash: the same redirect for any well-formed id.
    const bare = await ide().get(`/ide/${mine.id}?a=1`);
    expect(bare.status).toBe(308);
    expect(bare.headers.location).toBe(`/ide/${mine.id}/?a=1`);
    expect((await ide().get(`/ide/${crypto.randomUUID()}`)).status).toBe(308);
  });

  it('the IDE cookie expires, and stops working when its user leaves the project', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Rex Removed');
    await addMember(leader, project.id, member);
    const copy = await plainCopy(member, project.id);
    await markRunning(copy.id);
    const first = await redeem(await launchTicket(member, project.id));
    const second = await redeem(await launchTicket(member, project.id));
    const url = `/ide/${copy.id}/`;

    await prisma.ideSession.update({
      where: {
        id: createHash('sha256').update(first.cookie.split('=')[1]!).digest('hex'),
      },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await ide().get(url).set('Cookie', first.cookie)).status).toBe(404);
    expect((await ide().get(url).set('Cookie', second.cookie)).status).toBe(503);

    const res = await as(leader).delete(`/api/projects/${project.id}/members/${member.id}`);
    expect(res.status).toBe(204);
    expect((await ide().get(url).set('Cookie', second.cookie)).status).toBe(404);
  });

  it('WebSocket upgrades need the IDE site as Origin and the IDE cookie', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    await markRunning(copy.id);
    const { cookie } = await redeem(await launchTicket(leader, project.id));
    const path = `/ide/${copy.id}/`;
    const up = (headers: Record<string, string>, p = path) => upgradeStatus(ideServer, p, headers);

    expect(await up({ Cookie: cookie })).toMatch(/^HTTP\/1\.1 403/); // no Origin
    expect(await up({ Cookie: cookie, Origin: env.APP_ORIGIN })).toMatch(/^HTTP\/1\.1 403/);
    expect(await up({ Cookie: cookie, Origin: 'https://evil.example' })).toMatch(/^HTTP\/1\.1 403/);
    expect(await up({ Origin: env.IDE_ORIGIN })).toMatch(/^HTTP\/1\.1 404/);
    expect(await up({ Origin: env.IDE_ORIGIN, Cookie: leader.cookie })).toMatch(/^HTTP\/1\.1 404/);
    expect(await up({ Origin: env.IDE_ORIGIN, Cookie: cookie }, '/ide-launch')).toMatch(
      /^HTTP\/1\.1 404/,
    );
    // Past every check: 503, as there is no container behind this test copy.
    expect(await up({ Origin: env.IDE_ORIGIN, Cookie: cookie })).toMatch(/^HTTP\/1\.1 503/);
  });
});

describe('the app no longer serves the IDE', () => {
  it('/ide on the main port is a 404, and nothing there sets IDE cookies', async () => {
    const { leader, project } = await newProject();
    const copy = await plainCopy(leader, project.id);
    await markRunning(copy.id);
    // POST /copy/ide below finds no container behind this copy and really starts one.
    startedCopies.add(copy.id);
    for (const path of [`/ide/${copy.id}/`, `/ide/${copy.id}`, '/ide-launch?ticket=x']) {
      const res = await as(leader).get(path);
      expectError(res, 404, 'not_found');
      expect(setCookies(res).join()).not.toMatch(/vscode-tkn|devspace_ide/);
    }
    for (const res of [
      await as(leader).post(ideApi(project.id)),
      await as(leader).post(launchApi(project.id)),
      await as(leader).get(`/api/projects/${project.id}/copy`),
    ]) {
      expect(setCookies(res).join()).not.toMatch(/vscode-tkn|devspace_ide/);
    }
    // No WebSocket handling on the main port: an upgrade to /ide is just the app's 404.
    expect(
      await upgradeStatus(appServer, `/ide/${copy.id}/`, {
        Cookie: leader.cookie,
        Origin: env.APP_ORIGIN,
      }),
    ).toMatch(/^HTTP\/1\.1 404/);
  });
});

describe('/api Origin guard', () => {
  it('refuses non-GET requests from any other origin, including the IDE site', async () => {
    const user = await signUp('Gus Guard');
    const post = (origin?: string) => {
      const req = as(user).post('/api/teams', { name: 'Guarded' });
      return origin === undefined ? req : req.set('Origin', origin);
    };
    expectError(await post(env.IDE_ORIGIN), 403, 'forbidden_origin');
    expectError(await post('https://evil.example'), 403, 'forbidden_origin');
    expectError(await post('null'), 403, 'forbidden_origin');
    expect((await post(env.APP_ORIGIN)).status).toBe(201);
    expect((await post()).status).toBe(201);
    const del = await as(user).delete('/api/teams/x').set('Origin', env.IDE_ORIGIN);
    expectError(del, 403, 'forbidden_origin');
    // Reads aren't affected.
    expect((await as(user).get('/api/auth/me').set('Origin', env.IDE_ORIGIN)).status).toBe(200);
  });
});

describe('proxy helpers', () => {
  it('forwards no browser credentials, only the IDE token', () => {
    const headers = forwardHeaders(
      {
        host: '127.0.0.1:3100',
        cookie: `${SESSION_COOKIE_NAME}=secret; devspace_ide=x; vscode-tkn=old`,
        authorization: 'Bearer x',
        'x-forwarded-for': '1.2.3.4',
        connection: 'keep-alive, x-hop',
        'x-hop': 'y',
        accept: 'text/html',
      },
      'tok',
    );
    expect(headers).toEqual({
      host: '127.0.0.1:3100',
      accept: 'text/html',
      cookie: 'vscode-tkn=tok',
    });
  });

  it('parses only /ide/<uuid> paths, and every value of a cookie', () => {
    const id = crypto.randomUUID();
    expect(parseIdePath(`/ide/${id}/x/y?z=1`)).toEqual({ copyId: id, bare: false });
    expect(parseIdePath(`/ide/${id}?z=1`)).toEqual({ copyId: id, bare: true });
    expect(parseIdePath(`http://evil/ide/${id}/`)).toBeNull();
    expect(parseIdePath(`/ide/${id.toUpperCase()}/`)).toBeNull();
    expect(parseIdePath('/ide/../api/')).toBeNull();
    expect(cookieValues('a=1; devspace_ide=x; b=2; devspace_ide=y', 'devspace_ide')).toEqual([
      'x',
      'y',
    ]);
    expect(cookieValues(undefined, 'devspace_ide')).toEqual([]);
  });
});

// ---------- Docker needed ----------

describe.skipIf(!available.docker)('failed starts (needs Docker)', () => {
  it('a missing image ends in failed with a logged reason', async () => {
    const { leader, project } = await newProject();
    const saved = env.IDE_IMAGE;
    env.IDE_IMAGE = 'devspace-ide:missing-for-test';
    try {
      const copy = await openIde(leader, project.id);
      expect(copy.containerStatus).toBe('starting');
      await waitForIdeStarts();
    } finally {
      env.IDE_IMAGE = saved;
    }
    const copy = await getCopy(leader, project.id);
    expect(copy.containerStatus).toBe('failed');
    expectError(await as(leader).post(launchApi(project.id)), 409, 'ide_not_running');
    const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.containerError).toMatch(/devspace-ide:missing-for-test isn't built/);
    // The reason stays on the server.
    const res = await as(leader).get(`/api/projects/${project.id}/copy`);
    expect(JSON.stringify(res.body)).not.toContain('missing-for-test');
  });
});

// ---------- The real IDE image needed ----------

describe.skipIf(!available.ide)(
  'real IDE containers (needs Docker, the image and the network)',
  () => {
    it(
      'starts one container with exactly the contract settings, then serves it only to its owner',
      { timeout: 180_000 },
      async () => {
        const { leader, project } = await newProject('Real IDE');
        const other = await signUp('Other Member');
        await addMember(leader, project.id, other);

        // Two clicks at once: one copy, one container, both answers `starting`.
        const [a, b] = await Promise.all([
          as(leader).post(ideApi(project.id)),
          as(leader).post(ideApi(project.id)),
        ]);
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(200);
        const first = CopyResponseSchema.parse(a.body).copy!;
        startedCopies.add(first.id);
        expect(CopyResponseSchema.parse(b.body).copy!.id).toBe(first.id);
        expect(first.containerStatus).toBe('starting');

        await waitForIdeStarts();
        const copy = await getCopy(leader, project.id);
        const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
        expect(copy.containerStatus, row.containerError ?? '').toBe('running');
        expect(copy.lastActiveAt).not.toBeNull();

        const list = await docker.listContainers({
          all: true,
          filters: { label: [`devspace.copy=${copy.id}`] },
        });
        expect(list).toHaveLength(1);

        // The real container's settings.
        const info = await docker.getContainer(containerName(copy.id)).inspect();
        const tokenVar = info.Config.Env.find((e) => e.startsWith('DEVSPACE_CONNECTION_TOKEN='))!;
        const token = tokenVar.slice('DEVSPACE_CONNECTION_TOKEN='.length);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(row.containerId).toBe(info.Id);
        expect(info.Name).toBe(`/devspace-ide-${copy.id}`);
        expect(info.Config.Image).toBe('devspace-ide:5');
        // Phase 12: the AI gateway token (only its hash in the database) and address.
        const aiVar = info.Config.Env.find((e) => e.startsWith('DEVSPACE_AI_TOKEN='))!;
        const aiToken = aiVar.slice('DEVSPACE_AI_TOKEN='.length);
        expect(aiToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(aiToken).not.toBe(token);
        expect(row.aiGatewayTokenHash).toBe(createHash('sha256').update(aiToken).digest('hex'));
        expect(info.Config.Env).toContain(
          `DEVSPACE_AI_BASE_URL=http://${env.AI_GATEWAY_HOST}:${env.AI_GATEWAY_PORT}/v1`,
        );
        expect(info.Config.Env.filter((e) => e.startsWith('DEVSPACE_')).sort()).toEqual(
          [
            'DEVSPACE_AI_BASE_URL',
            'DEVSPACE_AI_MODEL',
            'DEVSPACE_AI_TOKEN',
            'DEVSPACE_BASE_PATH',
            'DEVSPACE_CONNECTION_TOKEN',
          ].map((name) => expect.stringMatching(new RegExp(`^${name}=`))),
        );
        expect(info.Config.Labels).toMatchObject({
          'devspace.copy': copy.id,
          'devspace.project': project.id,
        });
        expect(info.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
        expect(info.Config.Env).toContain(`DEVSPACE_BASE_PATH=/ide/${copy.id}`);
        const host = info.HostConfig;
        expect(host.NanoCpus).toBe(NANO_CPUS);
        expect(host.NanoCpus).toBe(1e9);
        expect(host.Memory).toBe(MEMORY_BYTES);
        expect(host.Memory).toBe(2 * 1024 ** 3);
        expect(host.MemorySwap).toBe(host.Memory); // no swap on top
        expect(host.PidsLimit).toBe(PIDS_LIMIT);
        expect(host.PidsLimit).toBe(512);
        expect(host.SecurityOpt).toEqual(['no-new-privileges']);
        expect(host.CapDrop).toEqual(['ALL']);
        expect(host.CapAdd ?? []).toEqual([]);
        expect(host.Privileged).toBe(false);
        expect(host.NetworkMode).toBe('devspace-ide');
        expect(Object.keys(info.NetworkSettings.Networks)).toEqual(['devspace-ide']);
        expect(info.NetworkSettings.Networks['devspace-ide']!.IPAddress).toMatch(/^10\.213\.0\./);
        expect(host.PublishAllPorts).toBe(false);
        expect(Object.keys(host.PortBindings ?? {})).toEqual([]);
        expect(Object.values(info.NetworkSettings.Ports ?? {}).filter(Boolean)).toEqual([]);
        expect(host.Binds ?? []).toEqual([]);
        expect(info.Mounts).toHaveLength(1);
        expect(info.Mounts[0]).toMatchObject({
          Type: 'bind',
          Source: copyDir(project.id, copy.id),
          Destination: '/home/workspace',
        });
        expect(JSON.stringify(info.Mounts)).not.toContain('docker.sock');

        // The app's origin never gets the token, a path or an IDE cookie.
        const launch = await as(leader).post(launchApi(project.id));
        for (const res of [
          a,
          b,
          launch,
          await as(leader).get(`/api/projects/${project.id}/copy`),
        ]) {
          expect(JSON.stringify(res.body)).not.toContain(token);
          expect(JSON.stringify(res.body)).not.toContain(env.COPIES_DIR);
          expect(JSON.stringify(res.headers)).not.toContain(token);
          expect(setCookies(res).join()).not.toMatch(/vscode-tkn|devspace_ide/);
        }

        // The IDE site: the launch sets both cookies, scoped to this copy only.
        const ticket = new URL(IdeLaunchResponseSchema.parse(launch.body).url).searchParams.get(
          'ticket',
        )!;
        const { all, cookie } = await redeem(ticket);
        const tkn = all.find((c) => c.startsWith('vscode-tkn='))!;
        expect(tkn.split('; ')[0]).toBe(`vscode-tkn=${token}`);
        const tknAttrs = tkn.split('; ').slice(1);
        expect(tknAttrs).toEqual(
          expect.arrayContaining([
            `Path=/ide/${copy.id}/`,
            'Max-Age=43200',
            'Secure',
            'SameSite=None',
            'Partitioned',
          ]),
        );
        expect(tknAttrs).not.toContain('HttpOnly'); // VS Code's page reads it
        expect(all.filter((c) => /Path=\/(;|$)/.test(c))).toEqual([]);

        // The owner gets VS Code, framed only by the app.
        const page = await ide().get(`/ide/${copy.id}/`).set('Cookie', cookie);
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.headers['set-cookie']).toBeUndefined();
        expect(page.headers['x-frame-options']).toBeUndefined();
        expectFramePolicy(page);
        // The app's session cookie (another member's or the owner's own) gets 404 here.
        expect((await ide().get(`/ide/${copy.id}/`).set('Cookie', other.cookie)).status).toBe(404);
        expect((await ide().get(`/ide/${copy.id}/`).set('Cookie', leader.cookie)).status).toBe(404);

        // WebSockets reach the IDE for the owner (101 Switching Protocols).
        const ws = `/ide/${copy.id}/?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
        expect(
          await upgradeStatus(ideServer, ws, { Cookie: cookie, Origin: env.IDE_ORIGIN }),
        ).toMatch(/^HTTP\/1\.1 101/);
        expect(
          await upgradeStatus(ideServer, ws, { Cookie: other.cookie, Origin: env.IDE_ORIGIN }),
        ).toMatch(/^HTTP\/1\.1 404/);

        // After an API restart the token is read back from the container.
        forgetIdeTarget(copy.id);
        expect((await ide().get(`/ide/${copy.id}/`).set('Cookie', cookie)).status).toBe(200);

        // Opening again while running reuses the same container.
        const again = await openIde(leader, project.id);
        expect(again.containerStatus).toBe('running');
        expect((await docker.getContainer(containerName(copy.id)).inspect()).Id).toBe(info.Id);

        // A container stopped behind our back is started again (the same one) on the next open.
        await docker.getContainer(info.Id).stop({ t: 1 });
        const restarted = await openIde(leader, project.id);
        expect(restarted.containerStatus).toBe('starting');
        await waitForIdeStarts();
        expect((await getCopy(leader, project.id)).containerStatus).toBe('running');
        const after = await docker.getContainer(containerName(copy.id)).inspect();
        expect(after.Id).toBe(info.Id);
        expect(after.State.Running).toBe(true);

        // Deleting the project removes its container and its IDE sessions.
        const del = await as(leader).delete(`/api/projects/${project.id}`, {
          confirmName: 'Real IDE',
        });
        expect(del.status).toBe(204);
        const gone = await docker
          .getContainer(info.Id)
          .inspect()
          .then(
            () => false,
            (err: unknown) => isNotFound(err),
          );
        expect(gone).toBe(true);
        expect(await prisma.ideSession.count({ where: { copyId: copy.id } })).toBe(0);
        expect((await ide().get(`/ide/${copy.id}/`).set('Cookie', cookie)).status).toBe(404);
      },
    );
  },
);
