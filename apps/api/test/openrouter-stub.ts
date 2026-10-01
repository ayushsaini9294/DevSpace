import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in OpenRouter for API tests (a test double: never used outside tests). It speaks the
 * real API's shapes for the calls DevSpace makes: the PKCE login page, the code exchange, key
 * info, the model list and chat completions. Tests script each model's answers.
 */

export type ModelAnswer =
  { status: number; body: unknown } | { content: string } | { timeout: true };

export interface StubCall {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  /** The request's headers, as received. */
  headers: IncomingMessage['headers'];
  /** The raw request body text. */
  rawBody: string;
}

export interface OpenRouterStub {
  url: string;
  calls: StubCall[];
  /**
   * While set, chat completions wait for it before answering (streamed answers send their first
   * chunk, then wait).
   */
  hold: Promise<void> | null;
  /** Keys handed out by the code exchange. */
  keys: string[];
  /** Scripted answers per model id (default: findings on the diff's first file). */
  answers: Map<string, ModelAnswer>;
  freeUsed: number;
  models: { id: string; name: string; context_length: number; pricing: object }[];
  /** A login as the browser would do it: GET /auth, follow nothing, return the redirect target. */
  login(authUrl: string): Promise<URL>;
  chatModels(): string[];
  close(): Promise<void>;
}

const FREE = { prompt: '0', completion: '0' };

export function defaultFindings(path: string, line: number): string {
  return JSON.stringify([
    { path, line, severity: 'high', title: 'Possible bug', detail: 'Check this line.' },
  ]);
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<{ json: unknown; text: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { json: text ? JSON.parse(text) : null, text };
  } catch {
    return { json: text, text };
  }
}

export async function startOpenRouterStub(): Promise<OpenRouterStub> {
  const codes = new Map<string, string>(); // code → challenge
  const sockets = new Set<import('node:net').Socket>();
  const stub = {
    url: '',
    calls: [] as StubCall[],
    hold: null,
    keys: [] as string[],
    answers: new Map<string, ModelAnswer>(),
    freeUsed: 3,
    models: [
      'qwen/qwen3.8-27b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-31b-it:free',
      'poolside/laguna-s-2.1:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/free',
    ].map((id) => ({ id, name: id, context_length: 131072, pricing: FREE })),
  } as OpenRouterStub;
  stub.models.push({
    id: 'openai/gpt-paid',
    name: 'Paid GPT',
    context_length: 128000,
    pricing: { prompt: '0.000002', completion: '0.000008' },
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const read = req.method === 'POST' ? await readJson(req) : { json: null, text: '' };
      const body = read.json;
      const auth = (req.headers.authorization as string | undefined) ?? null;
      stub.calls.push({
        method: req.method ?? '',
        path: url.pathname,
        auth,
        body,
        headers: req.headers,
        rawBody: read.text,
      });
      const keyOk = auth !== null && stub.keys.some((k) => auth === `Bearer ${k}`);

      if (req.method === 'GET' && url.pathname === '/auth') {
        const callback = url.searchParams.get('callback_url');
        const challenge = url.searchParams.get('code_challenge');
        if (!callback || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
          return send(res, 400, { error: { code: 400, message: 'bad auth request' } });
        }
        const code = randomBytes(12).toString('hex');
        codes.set(code, challenge);
        const target = new URL(callback);
        target.searchParams.set('code', code);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/keys') {
        const b = body as { code?: string; code_verifier?: string } | null;
        const challenge = b?.code ? codes.get(b.code) : undefined;
        const expected = b?.code_verifier
          ? createHash('sha256').update(b.code_verifier).digest('base64url')
          : '';
        if (!challenge || challenge !== expected) {
          return send(res, 403, { error: { code: 403, message: 'Invalid code or verifier' } });
        }
        codes.delete(b!.code!);
        const key = `sk-or-v1-stub-${randomBytes(24).toString('hex')}`;
        stub.keys.push(key);
        return send(res, 200, { key, user_id: 'user_stub' });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/key') {
        if (!keyOk) return send(res, 401, { error: { code: 401, message: 'No auth' } });
        return send(res, 200, {
          data: {
            label: 'stub',
            limit: null,
            usage: 0,
            is_free_tier: true,
            free_model_daily_requests: {
              used: stub.freeUsed,
              limit: 50,
              remaining: 50 - stub.freeUsed,
            },
          },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        return send(res, 200, { data: stub.models });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
        if (!keyOk) return send(res, 401, { error: { code: 401, message: 'User not found.' } });
        const b = body as { model: string; messages: { role: string; content: string }[] };
        const answer = stub.answers.get(b.model);
        if (answer && 'timeout' in answer) return; // never answers
        if (answer && 'status' in answer) return send(res, answer.status, answer.body);
        let content: string;
        if (answer && 'content' in answer) content = answer.content;
        else {
          const user = b.messages.find((m) => m.role === 'user')?.content ?? '';
          const path = /^\+\+\+ b\/(.+)$/m.exec(user)?.[1] ?? 'unknown';
          const line = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(user)?.[1] ?? 1);
          content = defaultFindings(path, line);
        }
        if ((body as { stream?: unknown }).stream === true) {
          // Server-sent events like OpenAI's: the first chunk, then (after `hold`) the rest.
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'set-cookie': 'stub_session=1; Path=/',
            'x-stub-internal': 'yes',
          });
          const chunk = (text: string, finish: string | null) =>
            `data: ${JSON.stringify({
              id: 'gen-stub',
              object: 'chat.completion.chunk',
              model: b.model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
            })}\n\n`;
          const half = Math.ceil(content.length / 2);
          res.write(chunk(content.slice(0, half), null));
          if (stub.hold) await stub.hold;
          res.write(chunk(content.slice(half), 'stop'));
          res.end('data: [DONE]\n\n');
          return;
        }
        if (stub.hold) await stub.hold;
        res.setHeader('set-cookie', 'stub_session=1; Path=/');
        return send(res, 200, {
          id: 'gen-stub',
          object: 'chat.completion',
          model: b.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }
      send(res, 404, { error: { code: 404, message: 'Not found' } });
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.login = async (authUrl: string) => {
    const res = await fetch(authUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status !== 302 || !location) throw new Error(`stub login failed: ${res.status}`);
    return new URL(location);
  };
  stub.chatModels = () =>
    stub.calls
      .filter((c) => c.path === '/api/v1/chat/completions')
      .map((c) => (c.body as { model: string }).model);
  stub.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return stub;
}
