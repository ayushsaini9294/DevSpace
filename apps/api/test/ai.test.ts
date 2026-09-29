import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConnectionViewSchema,
  AiReviewListResponseSchema,
  IdeReviewResponseSchema,
} from '@devspace/shared';
import { clearAiCaches } from '../src/ai/connection.ts';
import { decryptSecret, encryptSecret, SecretDecryptError } from '../src/ai/crypto.ts';
import { useOpenRouter } from '../src/ai/openrouter.ts';
import { runAiReview } from '../src/ai/run.ts';
import { env } from '../src/config/env.ts';
import { createLaunchUrl } from '../src/ide/access.ts';
import { createIdeServer } from '../src/ide/proxy.ts';
import { takeQueuedAiReviews } from '../src/jobs/ai-reviews.ts';
import { prisma } from '../src/lib/prisma.ts';
import { closeEmitter } from '../src/realtime/emitter.ts';
import { getRedis } from '../src/realtime/redis.ts';
import { as, cleanUp, commitFiles, expectError, signUp, type TestUser } from './helpers.ts';
import { startOpenRouterStub, type OpenRouterStub } from './openrouter-stub.ts';
import {
  changes,
  setPermissions,
  setSettings,
  submit,
  url,
  world,
  write,
  type World,
} from './phase7.ts';

vi.setConfig({ testTimeout: 60_000 });

let stub: OpenRouterStub;
let ideServer: Server;
const logged: string[] = [];

beforeAll(async () => {
  stub = await startOpenRouterStub();
  useOpenRouter({ baseUrl: stub.url, shortMs: 2_000, chatMs: 1_500 });
  ideServer = createIdeServer();
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));
  // Everything logged during these tests is checked for keys at the end.
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
  clearAiCaches();
  takeQueuedAiReviews();
});

afterEach(() => takeQueuedAiReviews());

afterAll(async () => {
  // The key never reached a log.
  for (const key of stub.keys) {
    for (const line of logged) expect(line).not.toContain(key);
  }
  vi.restoreAllMocks();
  ideServer.closeAllConnections();
  await new Promise((resolve) => ideServer.close(resolve));
  await stub.close();
  await closeEmitter();
  await cleanUp();
});

/** Connects `user` through the full PKCE flow with the stand-in; returns the key it got. */
async function connect(user: TestUser): Promise<string> {
  const start = await as(user).post('/api/ai/openrouter/start');
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const back = await stub.login(start.body.url);
  const finish = await as(user).post('/api/ai/openrouter/finish', {
    code: back.searchParams.get('code'),
    state: back.searchParams.get('state'),
  });
  expect(finish.status, JSON.stringify(finish.body)).toBe(200);
  return stub.keys.at(-1)!;
}

async function acceptNotice(user: TestUser) {
  const res = await as(user).post('/api/ai/notice/accept');
  expect(res.status).toBe(200);
}

/** A world with AI on, `rev` allowed to ask, connected and past the notice, and a submission. */
async function aiWorld() {
  const w = await world();
  await setSettings(w, { aiReviewEnabled: true });
  await setPermissions(w.leader, w.projectId, w.rev, {
    comment: true,
    approve: true,
    aiReview: true,
  });
  const key = await connect(w.rev);
  await acceptNotice(w.rev);
  write(w.annCopy, 'src/a.ts', 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
  const sub = await submit(w, w.ann, ['src/a.ts']);
  return { w, key, sub };
}

async function reviews(w: World, id: string, user: TestUser) {
  const res = await as(user).get(url(w, `/submissions/${id}/ai-reviews`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return AiReviewListResponseSchema.parse(res.body);
}

async function runQueued(): Promise<string[]> {
  const ids = takeQueuedAiReviews();
  await Promise.all(ids.map((id) => runAiReview(id)));
  return ids;
}

describe('secrets', () => {
  it('round-trips with a fresh IV, and refuses a tampered value or another key', () => {
    const a = encryptSecret('sk-or-v1-secret');
    const b = encryptSecret('sk-or-v1-secret');
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(decryptSecret(a)).toBe('sk-or-v1-secret');
    const parts = a.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow(SecretDecryptError);
    expect(() => decryptSecret(a, Buffer.alloc(32, 1))).toThrow(SecretDecryptError);
    expect(env.AI_SECRETS_KEY.length).toBe(32);
  });
});

describe('connecting OpenRouter', () => {
  it('uses PKCE, stores the key encrypted, and never returns it', async () => {
    const user = await signUp('Kai Key');
    const start = await as(user).post('/api/ai/openrouter/start');
    const auth = new URL(start.body.url);
    expect(auth.origin).toBe(stub.url);
    expect(auth.pathname).toBe('/auth');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(auth.searchParams.get('callback_url')!);
    expect(`${callback.origin}${callback.pathname}`).toBe(`${env.APP_ORIGIN}/settings/ai/callback`);
    const back = await stub.login(start.body.url);
    const finish = await as(user).post('/api/ai/openrouter/finish', {
      code: back.searchParams.get('code'),
      state: back.searchParams.get('state'),
    });
    expect(finish.status).toBe(200);
    const key = stub.keys.at(-1)!;
    const view = AiConnectionViewSchema.parse(finish.body);
    expect(view).toMatchObject({ connected: true, keyHint: key.slice(-4), noticeAcceptedAt: null });
    expect(view.freeRequestsToday).toEqual({ used: 3, limit: 50, remaining: 47 });
    for (const res of [start, finish, await as(user).get('/api/ai/connection')]) {
      expect(JSON.stringify(res.body)).not.toContain(key);
    }
    const row = await prisma.aiConnection.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.encryptedKey).not.toContain(key);
    expect(decryptSecret(row.encryptedKey)).toBe(key);

    const gone = await as(user).delete('/api/ai/connection');
    expect(gone.status).toBe(204);
    const after = AiConnectionViewSchema.parse((await as(user).get('/api/ai/connection')).body);
    expect(after).toMatchObject({ connected: false, keyHint: null, freeRequestsToday: null });
  });

  it('uses each state once, only for the same user and session, within 10 minutes', async () => {
    const user = await signUp('Sam State');
    const other = await signUp('Oli Other');
    const start = await as(user).post('/api/ai/openrouter/start');
    const back = await stub.login(start.body.url);
    const body = { code: back.searchParams.get('code'), state: back.searchParams.get('state') };
    // Another user, and another session of the same user, are refused.
    expectError(await as(other).post('/api/ai/openrouter/finish', body), 400, 'invalid_state');
    const login = await request((await import('./helpers.ts')).app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'a-good-password' });
    const secondSession = String(login.headers['set-cookie']![0]).split(';')[0]!;
    expectError(
      await as({ ...user, cookie: secondSession }).post('/api/ai/openrouter/finish', body),
      400,
      'invalid_state',
    );
    expect((await as(user).post('/api/ai/openrouter/finish', body)).status).toBe(200);
    expectError(await as(user).post('/api/ai/openrouter/finish', body), 400, 'invalid_state');

    // Expired.
    const late = await as(user).post('/api/ai/openrouter/start');
    const lateBack = await stub.login(late.body.url);
    await prisma.aiOAuthState.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expectError(
      await as(user).post('/api/ai/openrouter/finish', {
        code: lateBack.searchParams.get('code'),
        state: lateBack.searchParams.get('state'),
      }),
      400,
      'invalid_state',
    );
  });

  it('reports a refused code as openrouter_error', async () => {
    const user = await signUp('Bad Code');
    const start = await as(user).post('/api/ai/openrouter/start');
    const state = new URL(
      new URL(start.body.url).searchParams.get('callback_url')!,
    ).searchParams.get('state');
    expectError(
      await as(user).post('/api/ai/openrouter/finish', { code: 'wrong', state }),
      502,
      'openrouter_error',
    );
  });

  it('lists models with isFree and the configured lists', async () => {
    const user = await signUp('Model Viewer');
    const res = await as(user).get('/api/ai/models');
    expect(res.status).toBe(200);
    const paid = res.body.models.find((m: { id: string }) => m.id === 'openai/gpt-paid');
    expect(paid.isFree).toBe(false);
    expect(res.body.models[0].isFree).toBe(true);
    expect(res.body.defaults).toEqual(env.AI_DEFAULT_MODELS);
    expect(res.body.fallbacks).toEqual(env.AI_FALLBACK_MODELS);
  });
});

describe('cross-review', () => {
  it('checks the switch, permission, notice, connection and status', async () => {
    const w = await world();
    write(w.annCopy, 'src/b.ts', 'export const b = 22;\n');
    const sub = await submit(w, w.ann, ['src/b.ts']);
    const path = url(w, `/submissions/${sub.id}/ai-reviews`);
    // Off by default: every AI route answers ai_disabled.
    expectError(await as(w.leader).get(path), 409, 'ai_disabled');
    expectError(await as(w.leader).post(path), 409, 'ai_disabled');
    expectError(
      await as(w.leader).post(url(w, `/submissions/${sub.id}/ide-review`)),
      409,
      'ai_disabled',
    );
    // Members can't switch it.
    expectError(
      await as(w.bob).patch(url(w, '/settings'), { aiReviewEnabled: true }),
      403,
      'forbidden',
    );
    await setSettings(w, { aiReviewEnabled: true });
    expect((await as(w.bob).get(path)).status).toBe(200); // any member reads
    expectError(await as(w.bob).post(path), 403, 'forbidden'); // no aiReview permission
    expectError(await as(w.leader).post(path), 409, 'notice_required');
    await acceptNotice(w.leader);
    expectError(await as(w.leader).post(path), 409, 'not_connected');
    await connect(w.leader);
    const stranger = await signUp('Stranger');
    expectError(await as(stranger).get(path), 404, 'not_found');
    const closed = await as(w.ann).post(url(w, `/submissions/${sub.id}/close`));
    expect(closed.status).toBe(200);
    expectError(await as(w.leader).post(path), 409, 'submission_not_reviewable');
  });

  it('runs the default models, falls back on 429, groups agreement and notifies once', async () => {
    const { w, key, sub } = await aiWorld();
    stub.answers.set('google/gemma-4-31b-it:free', {
      status: 429,
      body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } },
    });
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const queued = AiReviewListResponseSchema.parse(res.body);
    expect(queued.reviews.map((r) => r.status)).toEqual(['queued', 'queued', 'queued']);
    expect(queued.running).toBe(true);
    // One at a time per member and submission.
    expectError(
      await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`)),
      409,
      'ai_review_running',
    );
    const before = stub.calls.length;
    await runQueued();

    const list = await reviews(w, sub.id, w.ann);
    expect(list.running).toBe(false);
    expect(list.reviews.every((r) => r.status === 'done')).toBe(true);
    const gemma = list.reviews.find((r) => r.requestedModel === 'google/gemma-4-31b-it:free')!;
    expect(gemma.model).toBe('poolside/laguna-s-2.1:free');
    expect(gemma.isFree).toBe(true);
    // Every chat call carried the key in the header only; the diff was in the user message.
    const chats = stub.calls.slice(before).filter((c) => c.path === '/api/v1/chat/completions');
    expect(chats.every((c) => c.auth === `Bearer ${key}`)).toBe(true);
    const userMessage = (chats[0]!.body as { messages: { role: string; content: string }[] })
      .messages[1]!;
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toContain('+++ b/src/a.ts');
    expect(userMessage.content).toContain('+export const a = 10;');

    expect(list.groups).toHaveLength(1);
    expect(list.groups[0]).toMatchObject({ path: 'src/a.ts', startLine: 1, severity: 'high' });
    expect(list.groups[0]!.agreedBy).toHaveLength(3);
    expect(JSON.stringify(list)).not.toContain(key);

    const notes = await prisma.notification.findMany({
      where: { userId: w.rev.id, type: 'ai_review.finished' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({
      submissionId: sub.id,
      done: 3,
      failed: 0,
      findingCount: 3,
    });
  });

  it('tries fallbacks in order, skipping models already in the request, then fails clearly', async () => {
    const { w, sub } = await aiWorld();
    const limited = {
      status: 429,
      body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } },
    };
    for (const m of stub.models) stub.answers.set(m.id, limited);
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`), {
      models: ['qwen/qwen3.8-27b:free', 'poolside/laguna-s-2.1:free'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const before = stub.chatModels().length;
    const ids = takeQueuedAiReviews();
    await runAiReview(ids[0]!);
    const tried = stub.chatModels().slice(before);
    const first = await prisma.aiReview.findUniqueOrThrow({ where: { id: ids[0]! } });
    const expected = [
      first.requestedModel,
      ...env.AI_FALLBACK_MODELS.filter(
        (m) => m !== 'poolside/laguna-s-2.1:free' && m !== 'qwen/qwen3.8-27b:free',
      ),
    ];
    expect(tried).toEqual(expected);
    expect(first.status).toBe('failed');
    expect(first.errorCode).toBe('daily_limit');
    expect(first.error).toContain('50/day');
    await runAiReview(ids[1]!);
  });

  it('falls back on 5xx, timeouts and empty answers', async () => {
    const { w, sub } = await aiWorld();
    stub.answers.set('qwen/qwen3.8-27b:free', {
      status: 502,
      body: { error: { message: 'down' } },
    });
    stub.answers.set('poolside/laguna-s-2.1:free', { timeout: true });
    stub.answers.set('nvidia/nemotron-3-super-120b-a12b:free', { content: '   ' });
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`), {
      models: ['qwen/qwen3.8-27b:free'],
    });
    expect(res.status).toBe(201);
    await runQueued();
    const [review] = (await reviews(w, sub.id, w.rev)).reviews;
    expect(review).toMatchObject({ status: 'done', model: 'openrouter/free' });
  });

  it('needs confirmPaid for paid models and knows only real models', async () => {
    const { w, sub } = await aiWorld();
    const path = url(w, `/submissions/${sub.id}/ai-reviews`);
    const paid = await as(w.rev).post(path, { models: ['openai/gpt-paid'] });
    expectError(paid, 409, 'paid_confirmation_required');
    expect(paid.body.details.models).toEqual(['openai/gpt-paid']);
    expectError(await as(w.rev).post(path, { models: ['no/such-model'] }), 400, 'unknown_model');
    expectError(
      await as(w.rev).post(path, { models: ['a', 'b', 'c', 'd'] }),
      400,
      'validation_error',
    );
    const ok = await as(w.rev).post(path, { models: ['openai/gpt-paid'], confirmPaid: true });
    expect(ok.status).toBe(201);
    expect(ok.body.reviews[0]).toMatchObject({ model: 'openai/gpt-paid', isFree: false });
  });

  it('parses tolerantly and keeps the raw answer when it can’t', async () => {
    const { w, sub } = await aiWorld();
    stub.answers.set('qwen/qwen3.8-27b:free', {
      content:
        'Sure! Here you go:\n```json\n[{"path":"./src/a.ts","line":"1","severity":"CRITICAL","title":"T","detail":"D"}]\n```',
    });
    stub.answers.set('nvidia/nemotron-3-ultra-550b-a55b:free', { content: 'No JSON here, sorry.' });
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`), {
      models: ['qwen/qwen3.8-27b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
    });
    expect(res.status).toBe(201);
    await runQueued();
    const list = await reviews(w, sub.id, w.rev);
    const good = list.reviews.find((r) => r.model === 'qwen/qwen3.8-27b:free')!;
    expect(good.findings).toEqual([
      { path: 'src/a.ts', line: 1, severity: 'high', title: 'T', detail: 'D' },
    ]);
    expect(good.parseError).toBe(false);
    const bad = list.reviews.find((r) => r.model === 'nvidia/nemotron-3-ultra-550b-a55b:free')!;
    expect(bad).toMatchObject({
      status: 'done',
      parseError: true,
      findings: [],
      raw: 'No JSON here, sorry.',
    });
  });

  it('fails with too_large above 150 KB without calling a model', async () => {
    const { w } = await aiWorld();
    write(w.annCopy, 'big.txt', 'x'.repeat(100) + '\n'.repeat(1) + 'line\n'.repeat(40_000));
    const sub = await submit(w, w.ann, ['big.txt'], 'Big');
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`), {
      models: ['qwen/qwen3.8-27b:free'],
    });
    expect(res.status).toBe(201);
    const before = stub.chatModels().length;
    await runQueued();
    expect(stub.chatModels().length).toBe(before);
    const [review] = (await reviews(w, sub.id, w.rev)).reviews;
    expect(review).toMatchObject({ status: 'failed', errorCode: 'too_large' });
  });

  it('fails with not_connected when the key was removed before the job ran', async () => {
    const { w, sub } = await aiWorld();
    expect(
      (
        await as(w.rev).post(url(w, `/submissions/${sub.id}/ai-reviews`), {
          models: ['openrouter/free'],
        })
      ).status,
    ).toBe(201);
    await as(w.rev).delete('/api/ai/connection');
    await runQueued();
    const [review] = (await reviews(w, sub.id, w.rev)).reviews;
    expect(review).toMatchObject({ status: 'failed', errorCode: 'not_connected' });
  });
});

describe('review with my IDE AI', () => {
  it('writes the folder into the reviewer’s own copy, needs no key, and is never submitted', async () => {
    const w = await world();
    await setSettings(w, { aiReviewEnabled: true });
    await setPermissions(w.leader, w.projectId, w.rev, { aiReview: true });
    await acceptNotice(w.rev);
    write(w.annCopy, 'src/a.ts', 'export const a = 10;\n');
    const sub = await submit(w, w.ann, ['src/a.ts'], 'IDE please', 'Look at a');
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/ide-review`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = IdeReviewResponseSchema.parse(res.body);
    expect(body).toEqual({
      folder: `.devspace/reviews/${sub.id}`,
      files: ['REVIEW.md', 'changes.diff', 'findings.md'],
      idePath: `/projects/${w.projectId}/ide`,
    });
    const copy = await prisma.copy.findUniqueOrThrow({
      where: { projectId_userId: { projectId: w.projectId, userId: w.rev.id } },
    });
    const { copyDir } = await import('../src/copies/service.ts');
    const root = copyDir(w.projectId, copy.id);
    const folder = join(root, body.folder);
    expect(readFileSync(join(folder, 'REVIEW.md'), 'utf8')).toContain('IDE please');
    expect(readFileSync(join(folder, 'changes.diff'), 'utf8')).toContain('+export const a = 10;');
    expect(readFileSync(join(folder, 'findings.md'), 'utf8')).toContain('[]');
    // Never in Submit work.
    expect((await changes(w, w.rev)).files).toEqual([]);
    // A second run keeps the reviewer's findings.
    write(root, `${body.folder}/findings.md`, '[{"path":"src/a.ts"}]');
    expect((await as(w.rev).post(url(w, `/submissions/${sub.id}/ide-review`))).status).toBe(201);
    expect(readFileSync(join(folder, 'findings.md'), 'utf8')).toBe('[{"path":"src/a.ts"}]');
  });

  it('never writes through a symlinked .devspace folder', async () => {
    const w = await world();
    await setSettings(w, { aiReviewEnabled: true });
    await acceptNotice(w.bob);
    write(w.annCopy, 'src/a.ts', 'export const a = 10;\n');
    const sub = await submit(w, w.ann, ['src/a.ts']);
    const outside = mkdtempSync(join(tmpdir(), 'devspace-outside-'));
    symlinkSync(outside, join(w.bobCopy, '.devspace'));
    await setPermissions(w.leader, w.projectId, w.bob, { aiReview: true });
    expectError(
      await as(w.bob).post(url(w, `/submissions/${sub.id}/ide-review`)),
      409,
      'copy_changed',
    );
    expect(existsSync(join(outside, 'reviews'))).toBe(false);
    expect(existsSync(join(outside, '.gitignore'))).toBe(false);
  });

  it('copy updates never touch .devspace, even when main has it', async () => {
    const w = await world();
    mkdirSync(join(w.annCopy, '.devspace'), { recursive: true });
    write(w.annCopy, '.devspace/mine.txt', 'mine\n');
    await commitFiles(w.gitDir, {
      'README.md': '# Project\n',
      'src/a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
      'src/b.ts': 'export const b = 2;\n',
      'docs/c.md': 'Docs v2\n',
      '.devspace/evil.txt': 'from main\n',
      '.devspace/mine.txt': 'overwritten\n',
    });
    const res = await as(w.ann).post(url(w, '/copy/update'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(join(w.annCopy, 'docs/c.md'), 'utf8')).toBe('Docs v2\n');
    expect(existsSync(join(w.annCopy, '.devspace/evil.txt'))).toBe(false);
    expect(readFileSync(join(w.annCopy, '.devspace/mine.txt'), 'utf8')).toBe('mine\n');
    expect((await changes(w, w.ann)).files).toEqual([]);
  });
});

describe('review findings from the IDE', () => {
  async function ideCookie(user: TestUser, copyId: string): Promise<string> {
    const u = new URL(await createLaunchUrl(user.id, copyId));
    const res = await request(ideServer).get(`${u.pathname}${u.search}`);
    expect(res.status).toBe(303);
    const raw = res.headers['set-cookie'] as unknown as string[];
    return raw.find((c) => c.startsWith('devspace_ide='))!.split(';')[0]!;
  }

  function send(
    copyId: string,
    cookie: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    let req = request(ideServer)
      .post(`/ide/${copyId}/__devspace/review-findings`)
      .set('Origin', env.IDE_ORIGIN)
      .set('Content-Type', 'application/json');
    if (cookie) req = req.set('Cookie', cookie);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function clearRate() {
    const keys = await getRedis().keys('devspace:ai:findings-rate:*');
    if (keys.length > 0) await getRedis().del(...keys);
  }

  it('stores an ide review for the copy owner, and refuses everything else', async () => {
    const w = await world();
    await setSettings(w, { aiReviewEnabled: true });
    await setPermissions(w.leader, w.projectId, w.bob, { aiReview: true });
    write(w.annCopy, 'src/a.ts', 'export const a = 10;\n');
    const sub = await submit(w, w.ann, ['src/a.ts']);
    const bobCookie = await ideCookie(w.bob, w.bobCopyId);
    const findings =
      '# notes\n[{"path":"src/a.ts","line":1,"severity":"low","title":"Nit","detail":"x"}]';
    const body = { submissionId: sub.id, findings };

    await clearRate();
    const noNotice = await send(w.bobCopyId, bobCookie, body);
    expect(noNotice.status).toBe(409);
    expect(noNotice.body).toMatchObject({ error: 'notice_required' });
    await acceptNotice(w.bob);

    // Wrong origin, content type, no session.
    expect((await send(w.bobCopyId, bobCookie, body, { Origin: env.APP_ORIGIN })).status).toBe(403);
    expect(
      (await send(w.bobCopyId, bobCookie, body, { 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    expect((await send(w.bobCopyId, null, body)).status).toBe(404);
    expect(
      (await send(w.bobCopyId, bobCookie, { submissionId: sub.id, findings: 'x'.repeat(200_000) }))
        .status,
    ).toBe(413);
    await clearRate();
    const tooBig = await send(w.bobCopyId, bobCookie, {
      submissionId: sub.id,
      findings: 'x'.repeat(60_000),
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toMatchObject({ error: 'validation_error' });

    await clearRate();
    const ok = await send(w.bobCopyId, bobCookie, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ findingCount: 1, parseError: false });
    const list = await reviews(w, sub.id, w.ann);
    expect(list.reviews[0]).toMatchObject({
      source: 'ide',
      model: 'IDE AI (reported by Bob Builder)',
      isFree: null,
      status: 'done',
    });
    // Rate limited right after.
    expect((await send(w.bobCopyId, bobCookie, body)).status).toBe(429);

    // A lead helping in bob's copy isn't the owner.
    await clearRate();
    const leadCookie = await ideCookie(w.leader, w.bobCopyId);
    const lead = await send(w.bobCopyId, leadCookie, body);
    expect(lead.status).toBe(403);
    expect(lead.body).toMatchObject({ error: 'forbidden' });

    // Switched off → ai_disabled.
    await clearRate();
    await setSettings(w, { aiReviewEnabled: false });
    expect((await send(w.bobCopyId, bobCookie, body)).body).toMatchObject({ error: 'ai_disabled' });
  });
});
