import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  CopyResponseSchema,
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
import { attachIdeUpgrades, forwardHeaders, parseIdePath } from '../src/ide/proxy.ts';
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
  await cleanUp();
});

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
        `Host: localhost:${port}`,
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
    socket.on('error', reject);
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

let server: Server;
beforeAll(async () => {
  server = createServer(app);
  attachIdeUpgrades(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------- Always: refusals and ownership ----------

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
});

describe('/ide proxy ownership', () => {
  it('only the owner gets past the check; everyone else gets the same 404 as an unknown copy', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Mo Member');
    await addMember(leader, project.id, member);
    const outsider = await signUp('Olly Outsider');
    const copy = await plainCopy(member, project.id);
    expect(copy.ideUrl).toBeNull();
    const url = `/ide/${copy.id}/`;

    // The owner: known, but no IDE running yet.
    expectError(await as(member).get(url), 503, 'ide_not_running');
    // The project's leader, an outsider, nobody, an unknown id, a malformed id: all 404.
    expectError(await as(leader).get(url), 404, 'not_found');
    expectError(await as(outsider).get(url), 404, 'not_found');
    expectError(await request(app).get(url), 404, 'not_found');
    expectError(await as(member).get(`/ide/${crypto.randomUUID()}/`), 404, 'not_found');
    expectError(await as(member).get('/ide/not-a-copy/'), 404, 'not_found');
    expectError(await as(member).get('/ide/'), 404, 'not_found');
    // The same for other methods.
    expectError(await as(leader).post(url), 404, 'not_found');

    // Without the trailing slash: the owner is redirected, others still get 404.
    const bare = await as(member).get(`/ide/${copy.id}?a=1`);
    expect(bare.status).toBe(308);
    expect(bare.headers.location).toBe(`/ide/${copy.id}/?a=1`);
    expectError(await as(leader).get(`/ide/${copy.id}`), 404, 'not_found');
  });

  it('a member removed from the project loses access to their own copy', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Rex Removed');
    await addMember(leader, project.id, member);
    const copy = await plainCopy(member, project.id);
    expectError(await as(member).get(`/ide/${copy.id}/`), 503, 'ide_not_running');
    const res = await as(leader).delete(`/api/projects/${project.id}/members/${member.id}`);
    expect(res.status).toBe(204);
    expectError(await as(member).get(`/ide/${copy.id}/`), 404, 'not_found');
  });

  it('WebSocket upgrades get the same checks, and a cross-site origin is refused', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Wes Socket');
    await addMember(leader, project.id, member);
    const copy = await plainCopy(member, project.id);
    const path = `/ide/${copy.id}/`;
    const { port } = server.address() as AddressInfo;

    expect(await upgradeStatus(server, path, {})).toMatch(/^HTTP\/1\.1 404/);
    expect(await upgradeStatus(server, path, { Cookie: leader.cookie })).toMatch(/^HTTP\/1\.1 404/);
    expect(
      await upgradeStatus(server, `/ide/${crypto.randomUUID()}/`, { Cookie: member.cookie }),
    ).toMatch(/^HTTP\/1\.1 404/);
    expect(
      await upgradeStatus(server, path, { Cookie: member.cookie, Origin: 'https://evil.example' }),
    ).toMatch(/^HTTP\/1\.1 403/);
    expect(
      await upgradeStatus(server, path, {
        Cookie: member.cookie,
        Origin: `http://localhost:${port}`,
      }),
    ).toMatch(/^HTTP\/1\.1 503/);
  });
});

describe('proxy helpers', () => {
  it('forwards no browser credentials, only the IDE token', () => {
    const headers = forwardHeaders(
      {
        host: 'localhost:5173',
        cookie: `${SESSION_COOKIE_NAME}=secret; other=1`,
        authorization: 'Bearer x',
        'x-forwarded-for': '1.2.3.4',
        connection: 'keep-alive, x-hop',
        'x-hop': 'y',
        accept: 'text/html',
      },
      'tok',
    );
    expect(headers).toEqual({
      host: 'localhost:5173',
      accept: 'text/html',
      cookie: 'vscode-tkn=tok',
    });
  });

  it('parses only /ide/<uuid> paths', () => {
    const id = crypto.randomUUID();
    expect(parseIdePath(`/ide/${id}/x/y?z=1`)).toEqual({ copyId: id, bare: false });
    expect(parseIdePath(`/ide/${id}?z=1`)).toEqual({ copyId: id, bare: true });
    expect(parseIdePath(`http://evil/ide/${id}/`)).toBeNull();
    expect(parseIdePath(`/ide/${id.toUpperCase()}/`)).toBeNull();
    expect(parseIdePath('/ide/../api/')).toBeNull();
  });
});

// ---------- Docker needed ----------

describe.skipIf(!available.docker)('failed starts (needs Docker)', () => {
  it('a missing image ends in failed with a logged reason, and no IDE link', async () => {
    const { leader, project } = await newProject();
    const saved = env.IDE_IMAGE;
    env.IDE_IMAGE = 'devspace-ide:missing-for-test';
    try {
      const copy = await openIde(leader, project.id);
      expect(copy.containerStatus).toBe('starting');
      expect(copy.ideUrl).toBeNull();
      await waitForIdeStarts();
    } finally {
      env.IDE_IMAGE = saved;
    }
    const copy = await getCopy(leader, project.id);
    expect(copy.containerStatus).toBe('failed');
    expect(copy.ideUrl).toBeNull();
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
        expect(first.ideUrl).toBeNull();

        await waitForIdeStarts();
        const copy = await getCopy(leader, project.id);
        const row = await prisma.copy.findUniqueOrThrow({ where: { id: copy.id } });
        expect(copy.containerStatus, row.containerError ?? '').toBe('running');
        expect(copy.ideUrl).toBe(`/ide/${copy.id}/`);
        expect(copy.lastActiveAt).not.toBeNull();

        const list = await docker.listContainers({
          all: true,
          filters: { label: [`devspace.copy=${copy.id}`] },
        });
        expect(list).toHaveLength(1);

        // The real container's settings.
        const info = await docker.getContainer(containerName(copy.id)).inspect();
        const token = info.Config.Env.find((e) => e.startsWith('DEVSPACE_CONNECTION_TOKEN='))!;
        expect(token.length).toBeGreaterThan('DEVSPACE_CONNECTION_TOKEN='.length + 30);
        expect(row.containerId).toBe(info.Id);
        expect(info.Name).toBe(`/devspace-ide-${copy.id}`);
        expect(info.Config.Image).toBe('devspace-ide:1');
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

        // The owner gets VS Code; the token and paths never reach the browser.
        const page = await as(leader).get(`/ide/${copy.id}/`);
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.headers['set-cookie']).toBeUndefined();
        const secret = token.slice('DEVSPACE_CONNECTION_TOKEN='.length);
        for (const body of [
          a.body,
          b.body,
          (await as(leader).get(`/api/projects/${project.id}/copy`)).body,
        ]) {
          expect(JSON.stringify(body)).not.toContain(secret);
          expect(JSON.stringify(body)).not.toContain(env.COPIES_DIR);
        }
        // Another member of the same project gets 404.
        expectError(await as(other).get(`/ide/${copy.id}/`), 404, 'not_found');

        // WebSockets reach the IDE for the owner (it answers 101 Switching Protocols).
        const { port } = server.address() as AddressInfo;
        const ws = `/ide/${copy.id}/?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
        expect(
          await upgradeStatus(server, ws, {
            Cookie: leader.cookie,
            Origin: `http://localhost:${port}`,
          }),
        ).toMatch(/^HTTP\/1\.1 101/);
        expect(await upgradeStatus(server, ws, { Cookie: other.cookie })).toMatch(
          /^HTTP\/1\.1 404/,
        );

        // After an API restart the token is read back from the container.
        forgetIdeTarget(copy.id);
        expect((await as(leader).get(`/ide/${copy.id}/`)).status).toBe(200);

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

        // Deleting the project removes its container.
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
      },
    );
  },
);
