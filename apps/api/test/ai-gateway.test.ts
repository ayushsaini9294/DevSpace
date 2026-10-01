import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiGatewayErrorBodySchema,
  AiPreferencesSchema,
  CopyResponseSchema,
} from '@devspace/shared';
import {
  hashAiGatewayToken,
  newAiGatewayToken,
  setAiGatewayToken,
  utcDay,
} from '../src/ai/assistant.ts';
import { clearAiCaches } from '../src/ai/connection.ts';
import {
  createAiGatewayServer,
  listenAiGateway,
  resetAiGatewayLimits,
  startAiGateway,
  useAiGatewayLimits,
} from '../src/ai/gateway.ts';
import { useOpenRouter } from '../src/ai/openrouter.ts';
import { env } from '../src/config/env.ts';
import { aiGatewayBaseUrl, ideContainerSpec } from '../src/ide/docker.ts';
import { forgetIdeTarget, setIdeTargetForTests } from '../src/ide/service.ts';
import { prisma } from '../src/lib/prisma.ts';
import { closeEmitter } from '../src/realtime/emitter.ts';
import { as, cleanUp, expectError, type TestUser } from './helpers.ts';
import { startOpenRouterStub, type OpenRouterStub } from './openrouter-stub.ts';
import { setSettings, url, world, type World } from './phase7.ts';

vi.setConfig({ testTimeout: 60_000 });

const FREE = 'qwen/qwen3.8-27b:free';
const PAID = 'openai/gpt-paid';

let stub: OpenRouterStub;
let gateway: Server;
let port: number;
const logged: string[] = [];
/** Every gateway answer's text and headers, checked for keys at the end. */
const answers: string[] = [];

beforeAll(async () => {
  stub = await startOpenRouterStub();
  useOpenRouter({ baseUrl: stub.url, shortMs: 2_000, chatMs: 1_500 });
  gateway = createAiGatewayServer();
  await listenAiGateway(gateway, '127.0.0.1', 0);
  port = (gateway.address() as AddressInfo).port;
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
  stub.answers.clear();
  stub.hold = null;
  clearAiCaches();
  resetAiGatewayLimits();
});

afterAll(async () => {
  // The member's key never reached a log line or any gateway answer.
  expect(stub.keys.length).toBeGreaterThan(0);
  for (const key of stub.keys) {
    for (const line of logged) expect(line).not.toContain(key);
    for (const answer of answers) expect(answer).not.toContain(key);
  }
  vi.restoreAllMocks();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await stub.close();
  await closeEmitter();
  await cleanUp();
});

// ---------- Helpers ----------

interface GatewayAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
}

function call(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    raw?: Buffer;
    from?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<GatewayAnswer> {
  const payload =
    options.raw ??
    (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? (payload ? 'POST' : 'GET'),
        localAddress: options.from ?? '127.0.0.1',
        agent: false,
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          answers.push(text, JSON.stringify(res.headers));
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const chat = (token: string | null, body: object = { model: FREE, messages: [] }, from?: string) =>
  call('/v1/chat/completions', { token, body, from });

function expectGatewayError(res: GatewayAnswer, status: number, code: string): string {
  expect(res.status, res.text).toBe(status);
  const body = AiGatewayErrorBodySchema.parse(res.json);
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(10);
  return body.error.message;
}

/** Connects `user` to the stand-in OpenRouter (full PKCE flow); returns their key. */
async function connect(user: TestUser): Promise<string> {
  const start = await as(user).post('/api/ai/openrouter/start');
  expect(start.status).toBe(200);
  const back = await stub.login(start.body.url);
  const finish = await as(user).post('/api/ai/openrouter/finish', {
    code: back.searchParams.get('code'),
    state: back.searchParams.get('state'),
  });
  expect(finish.status, JSON.stringify(finish.body)).toBe(200);
  return stub.keys.at(-1)!;
}

/** Gives a copy a running "container" at `ip` (a stand-in: no Docker) and a fresh token. */
async function runningCopy(copyId: string, ip = '127.0.0.1'): Promise<string> {
  const token = newAiGatewayToken();
  await setAiGatewayToken(copyId, token);
  await prisma.copy.update({ where: { id: copyId }, data: { containerStatus: 'running' } });
  setIdeTargetForTests(copyId, { ip, token: 'ide-connection-token' });
  return token;
}

/** AI on, Ann connected and past the notice, her copy running at 127.0.0.1. */
async function readyWorld(): Promise<{ w: World; token: string; key: string }> {
  const w = await world();
  await setSettings(w, { aiReviewEnabled: true });
  const key = await connect(w.ann);
  expect((await as(w.ann).post('/api/ai/notice/accept')).status).toBe(200);
  const token = await runningCopy(w.annCopyId);
  return { w, token, key };
}

const chatCalls = () => stub.calls.filter((c) => c.path === '/api/v1/chat/completions');

// ---------- Tests ----------

describe('the listener', () => {
  it('binds only the gateway host: other local addresses are refused', async () => {
    expect(env.AI_GATEWAY_HOST).toBe('10.213.0.1');
    expect(env.AI_GATEWAY_PORT).toBe(3200);
    expect(aiGatewayBaseUrl()).toBe('http://10.213.0.1:3200/v1');
    expect((gateway.address() as AddressInfo).address).toBe('127.0.0.1');
    // 127.0.0.2 is this machine too, but not the bound address.
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.2', port });
      socket.on('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  it("keeps the API running and retries when the address doesn't exist", async () => {
    const before = logged.length;
    const running = startAiGateway({ host: '192.0.2.1', port: 0, retryMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(running.server.listening).toBe(false);
    const lines = logged.slice(before).filter((l) => l.includes('AI gateway not started'));
    expect(lines).toHaveLength(1); // said once, clearly
    expect(lines[0]).toMatch(/192\.0\.2\.1 doesn't exist.*npm run ide:network/);
    running.close();
  });

  it('serves only /v1/chat/completions (POST) and /v1/models (GET)', async () => {
    expectGatewayError(await call('/v1/other'), 404, 'not_found');
    expectGatewayError(await call('/'), 404, 'not_found');
    expectGatewayError(await call('/v1/chat/completions'), 405, 'method_not_allowed');
    expectGatewayError(
      await call('/v1/models', { method: 'POST', body: {} }),
      405,
      'method_not_allowed',
    );
  });
});

describe('auth', () => {
  it('needs the copy token, from that copy container IP', async () => {
    const { w, token } = await readyWorld();
    expect((await chat(token)).status).toBe(200);

    expectGatewayError(await chat(null), 401, 'invalid_token');
    expectGatewayError(await chat('not-a-real-token-at-all-000000'), 401, 'invalid_token');
    expectGatewayError(
      await call('/v1/chat/completions', {
        body: { model: FREE },
        headers: { authorization: `Basic ${token}` },
      }),
      401,
      'invalid_token',
    );
    // The right token from another address.
    expectGatewayError(await chat(token, undefined, '127.0.0.2'), 401, 'invalid_token');

    // Bob's token only works from Bob's container (127.0.0.2), never from Ann's.
    const bobToken = await runningCopy(w.bobCopyId, '127.0.0.2');
    expectGatewayError(await chat(bobToken), 401, 'invalid_token');

    // A new container's token replaces the old one.
    const rotated = await runningCopy(w.annCopyId);
    expectGatewayError(await chat(token), 401, 'invalid_token');
    expect((await chat(rotated)).status).toBe(200);
    const row = await prisma.copy.findUniqueOrThrow({ where: { id: w.annCopyId } });
    expect(row.aiGatewayTokenHash).toBe(hashAiGatewayToken(rotated));
    expect(JSON.stringify(row)).not.toContain(rotated);

    // A stopped IDE's token stops working.
    await prisma.copy.update({ where: { id: w.annCopyId }, data: { containerStatus: 'stopped' } });
    expectGatewayError(await chat(rotated), 401, 'invalid_token');
    forgetIdeTarget(w.annCopyId);
    forgetIdeTarget(w.bobCopyId);
  });
});

describe('refusals', () => {
  it('switch off, not connected, notice, paid model, ex-member: clear messages', async () => {
    const { w, token } = await readyWorld();
    const before = chatCalls().length;

    await setSettings(w, { aiReviewEnabled: false });
    expect(expectGatewayError(await chat(token), 403, 'ai_disabled')).toBe(
      'AI is switched off in this project. A leader can turn it on in Settings.',
    );
    expectGatewayError(await call('/v1/models', { token }), 403, 'ai_disabled');
    await setSettings(w, { aiReviewEnabled: true });

    await prisma.user.update({ where: { id: w.ann.id }, data: { aiNoticeAcceptedAt: null } });
    expectGatewayError(await chat(token), 403, 'notice_required');
    expect((await as(w.ann).post('/api/ai/notice/accept')).status).toBe(200);

    // Paid models need "Allow paid models".
    const msg = expectGatewayError(
      await chat(token, { model: PAID, messages: [] }),
      403,
      'paid_model_not_allowed',
    );
    expect(msg).toContain('Allow paid models');
    // A free `model` can't smuggle in paid fallbacks or paid plugins.
    for (const extra of [
      { models: [PAID] },
      { models: 'x' },
      { plugins: [{ id: 'web' }] },
      { web_search_options: {} },
      { preset: 'anything' },
    ]) {
      expectGatewayError(
        await chat(token, { model: 'openrouter/free', messages: [], ...extra }),
        403,
        'paid_model_not_allowed',
      );
    }
    expect(
      (
        await chat(token, {
          model: 'openrouter/free',
          models: ['qwen/qwen3.8-27b:free'],
          messages: [],
        })
      ).status,
    ).toBe(200);
    expect((await chat(token, { model: 'openrouter/free', messages: [] })).status).toBe(200);
    expectGatewayError(await chat(token, { messages: [] }), 400, 'invalid_request');
    expectGatewayError(
      await call('/v1/chat/completions', { token, raw: Buffer.from('{not json') }),
      400,
      'invalid_request',
    );

    // Bob hasn't connected OpenRouter.
    const bobToken = await runningCopy(w.bobCopyId);
    expect(expectGatewayError(await chat(bobToken), 403, 'not_connected')).toBe(
      'Connect OpenRouter in DevSpace → AI settings first.',
    );
    forgetIdeTarget(w.bobCopyId);

    // The refused requests above never reached OpenRouter; the two free ones did.
    expect(chatCalls().length - before).toBe(2);

    // Ann leaves the project: her copy's token no longer works.
    const removed = await as(w.leader).delete(url(w, `/members/${w.ann.id}`));
    expect(removed.status).toBe(204);
    // Removal stops her IDE in the background; wait for that, then pretend it still runs.
    for (let i = 0; i < 100; i++) {
      const row = await prisma.copy.findUniqueOrThrow({ where: { id: w.annCopyId } });
      if (row.containerStatus === 'stopped') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await prisma.copy.update({ where: { id: w.annCopyId }, data: { containerStatus: 'running' } });
    setIdeTargetForTests(w.annCopyId, { ip: '127.0.0.1', token: 'x' });
    expectGatewayError(await chat(token), 403, 'not_member');
    forgetIdeTarget(w.annCopyId);
  });

  it('GET /v1/models lists free models, and paid ones only after opting in', async () => {
    const { w, token } = await readyWorld();
    const free = await call('/v1/models', { token });
    expect(free.status).toBe(200);
    const ids = (free.json as { object: string; data: { id: string; object: string }[] }).data.map(
      (m) => m.id,
    );
    expect(ids).toContain(FREE);
    expect(ids).toContain('openrouter/free');
    expect(ids).not.toContain(PAID);

    const on = await as(w.ann).patch('/api/ai/preferences', { allowPaid: true });
    expect(on.status).toBe(200);
    expect(AiPreferencesSchema.parse(on.body).allowPaid).toBe(true);
    const all = await call('/v1/models', { token });
    expect((all.json as { data: { id: string }[] }).data.map((m) => m.id)).toContain(PAID);
    expect((await chat(token, { model: PAID, messages: [] })).status).toBe(200);
    forgetIdeTarget(w.annCopyId);
  });
});

describe('forwarding', () => {
  it("passes the request through with the owner's key and only safe headers", async () => {
    const { w, token, key } = await readyWorld();
    const request = {
      model: FREE,
      messages: [{ role: 'user', content: 'Build a to-do app' }],
      temperature: 0.3,
      tools: [{ type: 'function', function: { name: 'write_file' } }],
    };
    const res = await call('/v1/chat/completions', {
      token,
      body: request,
      headers: {
        cookie: 'devspace_session=abc',
        'x-private': 'secret',
        accept: 'application/json',
      },
    });
    expect(res.status, res.text).toBe(200);
    expect((res.json as { choices: unknown[] }).choices).toHaveLength(1);
    // Upstream cookies and other headers never reach the container.
    expect(res.headers['set-cookie']).toBeUndefined();

    const sent = chatCalls().at(-1)!;
    expect(sent.auth).toBe(`Bearer ${key}`);
    expect(sent.rawBody).toBe(JSON.stringify(request)); // as-is
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers['x-private']).toBeUndefined();
    expect(JSON.stringify(sent.headers)).not.toContain(token);

    // OpenRouter's own errors pass through with their status.
    stub.answers.set(FREE, {
      status: 429,
      body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } },
    });
    const limited = await chat(token);
    expect(limited.status).toBe(429);
    expect(limited.text).toContain('free-models-per-day');
    forgetIdeTarget(w.annCopyId);
  });

  it('streams server-sent events through as they come', async () => {
    const { w, token } = await readyWorld();
    stub.answers.set(FREE, { content: 'Hello from the stand-in model' });
    let release!: () => void;
    stub.hold = new Promise((resolve) => (release = resolve));

    const body = Buffer.from(JSON.stringify({ model: FREE, stream: true, messages: [] }));
    const result = await new Promise<{
      first: string;
      all: string;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          localAddress: '127.0.0.1',
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
        },
        (res) => {
          let all = '';
          let first = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (!first) {
              // The first event arrived while the model is still "thinking".
              first = chunk;
              release();
            }
            all += chunk;
          });
          res.on('end', () => resolve({ first, all, headers: res.headers }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    answers.push(result.all);
    expect(result.headers['content-type']).toBe('text/event-stream');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['x-stub-internal']).toBeUndefined();
    expect(result.first).toContain('Hello from');
    expect(result.first).not.toContain('[DONE]');
    expect(result.all).toContain('stand-in model');
    expect(result.all.trim().endsWith('data: [DONE]')).toBe(true);
    forgetIdeTarget(w.annCopyId);
  });

  it("times out when OpenRouter doesn't answer", async () => {
    const { w, token } = await readyWorld();
    useAiGatewayLimits({ timeoutMs: 300 });
    stub.answers.set(FREE, { timeout: true });
    expectGatewayError(await chat(token), 504, 'upstream_timeout');
    forgetIdeTarget(w.annCopyId);
  });
});

describe('limits', () => {
  it('refuses bodies over 4 MB', async () => {
    const { w, token } = await readyWorld();
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 'a');
    expectGatewayError(
      await call('/v1/chat/completions', { token, raw: big }),
      413,
      'request_too_large',
    );
    // Just under the limit is read (and refused only because it isn't JSON).
    const under = Buffer.alloc(4 * 1024 * 1024, 'a');
    expectGatewayError(
      await call('/v1/chat/completions', { token, raw: under }),
      400,
      'invalid_request',
    );
    forgetIdeTarget(w.annCopyId);
  });

  it('allows 2 requests at a time and 30 a minute per copy', async () => {
    const { w, token } = await readyWorld();
    let release!: () => void;
    stub.hold = new Promise((resolve) => (release = resolve));
    const before = chatCalls().length;
    const first = chat(token);
    const second = chat(token);
    // Wait until both are at OpenRouter.
    for (let i = 0; i < 200 && chatCalls().length < before + 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expectGatewayError(await chat(token), 429, 'too_many_requests');
    // Another copy has its own limits.
    const bobToken = await runningCopy(w.bobCopyId, '127.0.0.1');
    expectGatewayError(await chat(bobToken), 403, 'not_connected');
    release();
    stub.hold = null;
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);

    // 2 used so far this minute (the refused one isn't counted); 28 more are fine.
    for (let i = 0; i < 28; i++) expect((await chat(token)).status).toBe(200);
    expectGatewayError(await chat(token), 429, 'too_many_requests');
    forgetIdeTarget(w.annCopyId);
    forgetIdeTarget(w.bobCopyId);
  });
});

describe('usage and preferences', () => {
  it("counts the owner's requests per model and day, never the refused ones", async () => {
    const { w, token } = await readyWorld();
    const empty = AiPreferencesSchema.parse((await as(w.ann).get('/api/ai/preferences')).body);
    expect(empty).toEqual({
      allowPaid: false,
      assistantUsageToday: { day: utcDay(), requests: 0, models: [] },
    });
    await chat(token);
    await chat(token);
    await chat(token, { model: 'openrouter/free', messages: [] });
    await chat(token, { model: PAID, messages: [] }); // refused
    stub.answers.set(FREE, { status: 500, body: { error: { message: 'boom' } } });
    await chat(token); // failed upstream: not counted
    const prefs = AiPreferencesSchema.parse((await as(w.ann).get('/api/ai/preferences')).body);
    expect(prefs.assistantUsageToday).toEqual({
      day: utcDay(),
      requests: 3,
      models: [
        { model: FREE, requests: 2 },
        { model: 'openrouter/free', requests: 1 },
      ],
    });
    // Nobody else's.
    const bob = AiPreferencesSchema.parse((await as(w.bob).get('/api/ai/preferences')).body);
    expect(bob.assistantUsageToday.requests).toBe(0);
    forgetIdeTarget(w.annCopyId);
  });

  it('PATCH /api/ai/preferences validates and needs a login', async () => {
    const { w } = await readyWorld();
    expectError(
      await as(w.ann).patch('/api/ai/preferences', { allowPaid: 'yes' }),
      400,
      'validation_error',
    );
    expectError(await as(w.ann).patch('/api/ai/preferences', {}), 400, 'validation_error');
    const off = await as(w.ann).patch('/api/ai/preferences', { allowPaid: false });
    expect(off.status).toBe(200);
    expect(off.body.allowPaid).toBe(false);
    forgetIdeTarget(w.annCopyId);
  });
});

describe('the copy view and the container', () => {
  it('aiAssistant tells the IDE page why the assistant is not ready, for the owner', async () => {
    const w = await world();
    const view = async (user: TestUser, path = '/copy') =>
      CopyResponseSchema.parse((await as(user).get(url(w, path))).body).copy!.aiAssistant;
    expect(await view(w.ann)).toEqual({ ready: false, reason: 'ai_disabled' });
    await setSettings(w, { aiReviewEnabled: true });
    expect(await view(w.ann)).toEqual({ ready: false, reason: 'not_connected' });
    await connect(w.ann);
    expect(await view(w.ann)).toEqual({ ready: false, reason: 'notice_required' });
    await as(w.ann).post('/api/ai/notice/accept');
    expect(await view(w.ann)).toEqual({ ready: true, reason: null });
    // A lead looking at Ann's copy sees Ann's state, not their own.
    expect(await view(w.leader, `/members/${w.ann.id}/copy`)).toEqual({
      ready: true,
      reason: null,
    });
    expect(await view(w.leader, `/members/${w.bob.id}/copy`)).toEqual({
      ready: false,
      reason: 'not_connected',
    });
  });

  it('the container gets its gateway token and address, never the key', async () => {
    const w = await world();
    const key = await connect(w.ann);
    const spec = ideContainerSpec({
      copyId: w.annCopyId,
      projectId: w.projectId,
      hostDir: '/tmp/x',
      token: 'ide-token',
      aiToken: 'gateway-token',
    });
    expect(spec.Env).toEqual(
      expect.arrayContaining([
        'DEVSPACE_AI_TOKEN=gateway-token',
        'DEVSPACE_AI_BASE_URL=http://10.213.0.1:3200/v1',
        `DEVSPACE_AI_MODEL=${env.AI_DEFAULT_MODELS[0]}`,
      ]),
    );
    expect(JSON.stringify(spec)).not.toContain(key);
    expect(JSON.stringify(spec)).not.toContain(key.slice(-12));
    expect(spec.Image).toBe('devspace-ide:5');
  });
});
