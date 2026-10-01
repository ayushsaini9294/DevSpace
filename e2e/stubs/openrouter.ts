// TEST DOUBLE — a stand-in for OpenRouter, used only by the e2e tests and CI (Phase 10 contract,
// section 6). It is NOT OpenRouter and never talks to it; it holds no real keys and hands out fake
// ones. Playwright starts it (playwright.config.ts) and points the API and worker at it with
// OPENROUTER_BASE_URL. The real check uses the owner's own OpenRouter account and real free models.
//
// It answers the calls DevSpace makes, with real-shaped JSON:
// - GET  /auth?callback_url&code_challenge&code_challenge_method=S256  an "authorize" page whose
//        link goes back to callback_url with `code` added (OpenRouter's OAuth PKCE flow)
// - POST /api/v1/auth/keys  { code, code_verifier, code_challenge_method } → { key, user_id }
// - GET  /api/v1/key        the key's limits, including today's free-model requests
// - GET  /api/v1/models     free models (":free", zero pricing) and a few paid ones
// - POST /api/v1/chat/completions  findings as JSON, per model (see `answerFor`):
//        google/gemma-4-31b-it:free always answers 429 (free daily limit), so the fallback runs;
//        qwen and nemotron-ultra report the same path within ±3 lines, so they form an agreed group.
//        A request that offers tools (the IDE's AI assistant, Phase 12, through DevSpace's AI
//        gateway) gets an assistant's streamed answer instead (see `answerAssistant`).
// - GET  /__stub/requests   test-only: what was called (no keys), for assertions
// - GET  /__stub/health     test-only: readiness for Playwright
//
// Run: node e2e/stubs/openrouter.ts (Node 24 strips the types). Listens on 127.0.0.1 only.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.OPENROUTER_STUB_PORT || 4010);
const HOST = '127.0.0.1';

const FREE_DAILY_LIMIT = 50;
/** The model that always answers 429, so DevSpace's fallback order is exercised. */
const RATE_LIMITED_MODEL = 'google/gemma-4-31b-it:free';

type Pending = { challenge: string; method: string; used: boolean };
const codes = new Map<string, Pending>();
/** Fake keys handed out by /api/v1/auth/keys → free-model requests made today. */
const keys = new Map<string, { freeUsed: number }>();

type Logged = {
  at: string;
  method: string;
  path: string;
  status: number;
  model?: string;
  /** True when the request carried a key this stand-in issued. */
  authorized?: boolean;
  /** The last 4 characters of that key (what DevSpace's settings page shows), never the key. */
  keyEnding?: string;
  /** A chat request from an AI coding assistant (it offers tools), and whether it streamed. */
  assistant?: boolean;
  stream?: boolean;
};
const log: Logged[] = [];

const MODELS: { id: string; name: string; prompt: string; completion: string }[] = [
  { id: 'qwen/qwen3.8-27b:free', name: 'Qwen3.8 27B (free)', prompt: '0', completion: '0' },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'Nemotron 3 Ultra (free)',
    prompt: '0',
    completion: '0',
  },
  { id: RATE_LIMITED_MODEL, name: 'Gemma 4 31B (free)', prompt: '0', completion: '0' },
  { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1 (free)', prompt: '0', completion: '0' },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    name: 'Nemotron 3 Super (free)',
    prompt: '0',
    completion: '0',
  },
  { id: 'openrouter/free', name: 'Free Models Router', prompt: '0', completion: '0' },
  {
    id: 'stub/paid-large',
    name: 'Stand-in paid model',
    prompt: '0.000003',
    completion: '0.000015',
  },
  {
    id: 'stub/paid-small',
    name: 'Stand-in paid model (small)',
    prompt: '0.0000002',
    completion: '0.0000008',
  },
];

function isFree(model: string) {
  const m = MODELS.find((x) => x.id === model);
  return m ? m.prompt === '0' && m.completion === '0' : model.endsWith(':free');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, message: string) {
  json(res, status, { error: { code: status, message } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (\S+)$/.exec(header);
  return match && keys.has(match[1]!) ? match[1]! : null;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The first changed file and the first new line number of its first hunk, from a unified diff. */
function firstChange(text: string): { path: string; line: number } {
  const file = /^\+\+\+ b\/(.+)$/m.exec(text);
  if (!file) return { path: 'README.md', line: 1 };
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(text.slice(file.index));
  return { path: file[1]!.trim(), line: hunk ? Math.max(1, Number(hunk[1])) : 1 };
}

type Finding = {
  path: string;
  line: number;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
};

/** What each model "says" about the diff: real-shaped content, sometimes wrapped in prose. */
function answerFor(model: string, prompt: string): { status: number; content?: string } {
  if (model === RATE_LIMITED_MODEL) return { status: 429 };
  const { path, line } = firstChange(prompt);
  const agreed = (at: number, severity: Finding['severity']): Finding => ({
    path,
    line: at,
    severity,
    title: 'Unchecked input is used directly',
    detail: 'The new value is used without checking that it is present; handle the empty case.',
  });
  switch (model) {
    case 'qwen/qwen3.8-27b:free':
      // Plain JSON, as the system prompt asks.
      return { status: 200, content: JSON.stringify([agreed(line, 'high')]) };
    case 'nvidia/nemotron-3-ultra-550b-a55b:free':
      // Prose around a fenced JSON array: DevSpace takes the first JSON array (tolerant parsing).
      return {
        status: 200,
        content:
          'Here is my review of the changes.\n\n```json\n' +
          JSON.stringify([agreed(line + 1, 'medium')], null, 2) +
          '\n```\n',
      };
    case 'poolside/laguna-s-2.1:free':
    case 'nvidia/nemotron-3-super-120b-a12b:free':
    case 'openrouter/free':
    default: {
      const own: Finding = {
        path,
        line: line + 20,
        severity: 'low',
        title: 'Consider a clearer name',
        detail: 'A more descriptive name would make this change easier to follow.',
      };
      return { status: 200, content: JSON.stringify([own]) };
    }
  }
}

/** The file the stand-in assistant creates, in the copy (the IDE's folder). */
const ASSISTANT_FILE = '/home/workspace/hello-from-ai.html';
const ASSISTANT_TEXT = '<h1>Hello from the AI helper</h1>\n';

/**
 * An AI coding assistant's turn, OpenAI-style (streamed when asked): the first turn asks to create
 * ASSISTANT_FILE with the assistant's `editor` tool (Cline's); once a tool result comes back, it
 * says it is done. The assistant asks the member before it writes the file.
 */
function answerAssistant(res: ServerResponse, model: string, body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: unknown }[]) : [];
  const tools = (body.tools as { function?: { name?: unknown } }[]).map((t) => t?.function?.name);
  const done = messages.some((m) => m?.role === 'tool');
  const id = `gen-stub-${randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall =
    !done && tools.includes('editor')
      ? {
          id: `call_${randomBytes(6).toString('hex')}`,
          type: 'function' as const,
          function: {
            name: 'editor',
            arguments: JSON.stringify({ path: ASSISTANT_FILE, new_text: ASSISTANT_TEXT }),
          },
        }
      : null;
  const content = toolCall
    ? 'I will create hello-from-ai.html for you.'
    : 'Done: hello-from-ai.html is in your copy.';
  const finish = toolCall ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

  if (body.stream !== true) {
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          finish_reason: finish,
          message: { role: 'assistant', content, ...(toolCall ? { tool_calls: [toolCall] } : {}) },
        },
      ],
      usage,
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const chunk = (delta: unknown, finishReason: string | null = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      })}\n\n`,
    );
  chunk({ role: 'assistant', content });
  if (toolCall) chunk({ tool_calls: [{ index: 0, ...toolCall }] });
  chunk({}, finish, { usage });
  res.end('data: [DONE]\n\n');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const entry: Logged = {
    at: new Date().toISOString(),
    method: req.method ?? 'GET',
    path: url.pathname,
    status: 0,
  };
  res.on('finish', () => {
    entry.status = res.statusCode;
    if (!url.pathname.startsWith('/__stub/')) log.push(entry);
  });

  try {
    if (req.method === 'GET' && url.pathname === '/__stub/health')
      return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/__stub/requests')
      return json(res, 200, { requests: log });

    // The page OpenRouter shows the member: here, one link that authorizes at once.
    if (req.method === 'GET' && url.pathname === '/auth') {
      const callback = url.searchParams.get('callback_url') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const method = url.searchParams.get('code_challenge_method') ?? '';
      let target: URL;
      try {
        target = new URL(callback);
      } catch {
        return error(res, 400, 'callback_url is missing or invalid');
      }
      if (!/^(localhost|127\.0\.0\.1)$/.test(target.hostname) && target.protocol !== 'https:') {
        return error(res, 400, 'callback_url must be https or localhost');
      }
      if (!challenge || method !== 'S256') {
        return error(res, 400, 'code_challenge with code_challenge_method=S256 is required');
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge, method, used: false });
      target.searchParams.set('code', code);
      const href = escapeHtml(target.toString());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stand-in OpenRouter (test double)</title></head>
<body>
<h1>Stand-in OpenRouter (test double)</h1>
<p>This page is part of DevSpace's automated tests. It is not OpenRouter.</p>
<p><a href="${href}">Authorize DevSpace</a></p>
</body></html>`);
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/keys') {
      const body = await readJson(req);
      const code = typeof body?.code === 'string' ? body.code : '';
      const verifier = typeof body?.code_verifier === 'string' ? body.code_verifier : '';
      const pending = codes.get(code);
      if (!pending || pending.used) return error(res, 403, 'Invalid code');
      pending.used = true;
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (body?.code_challenge_method !== 'S256' || expected !== pending.challenge) {
        return error(res, 403, 'Invalid code_verifier');
      }
      const key = `sk-or-v1-stub-${randomBytes(24).toString('hex')}`;
      keys.set(key, { freeUsed: 0 });
      return json(res, 200, { key, user_id: `user_stub_${randomBytes(4).toString('hex')}` });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/key') {
      const key = bearer(req);
      entry.authorized = !!key;
      if (!key) return error(res, 401, 'No auth credentials found');
      const used = keys.get(key)!.freeUsed;
      return json(res, 200, {
        data: {
          label: `sk-or-v1-stu...${key.slice(-3)}`,
          limit: null,
          limit_remaining: null,
          usage: 0,
          is_free_tier: true,
          is_provisioning_key: false,
          rate_limit: { requests: 20, interval: '1m' },
          free_model_daily_requests: {
            used,
            limit: FREE_DAILY_LIMIT,
            remaining: Math.max(0, FREE_DAILY_LIMIT - used),
          },
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/models') {
      return json(res, 200, {
        data: MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          created: 1_790_000_000,
          description: `${m.name}, served by the stand-in OpenRouter for tests.`,
          context_length: 131_072,
          architecture: {
            modality: 'text->text',
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          pricing: { prompt: m.prompt, completion: m.completion, request: '0', image: '0' },
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const key = bearer(req);
      entry.authorized = !!key;
      if (!key) return error(res, 401, 'No auth credentials found');
      entry.keyEnding = key.slice(-4);
      const body = await readJson(req);
      const model = typeof body?.model === 'string' ? body.model : '';
      entry.model = model;
      if (!model) return error(res, 400, 'model is required');
      if (Array.isArray(body?.tools)) {
        entry.assistant = true;
        entry.stream = body.stream === true;
        if (isFree(model)) keys.get(key)!.freeUsed += 1;
        return answerAssistant(res, model, body);
      }
      const messages = Array.isArray(body?.messages) ? (body.messages as unknown[]) : [];
      const prompt = messages
        .map((m) => (m && typeof m === 'object' ? (m as { content?: unknown }).content : ''))
        .map((c) => (typeof c === 'string' ? c : JSON.stringify(c ?? '')))
        .join('\n');

      const usage = keys.get(key)!;
      if (isFree(model)) usage.freeUsed += 1;
      if (isFree(model) && usage.freeUsed > FREE_DAILY_LIMIT) {
        return error(
          res,
          429,
          'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
        );
      }

      const answer = answerFor(model, prompt);
      if (answer.status === 429) {
        return error(
          res,
          429,
          'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
        );
      }
      // A little latency, like a real model, so "running" can be seen.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return json(res, 200, {
        id: `gen-stub-${randomBytes(8).toString('hex')}`,
        provider: 'Stand-in',
        model,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [
          {
            index: 0,
            logprobs: null,
            finish_reason: 'stop',
            native_finish_reason: 'stop',
            message: { role: 'assistant', content: answer.content, refusal: null, reasoning: null },
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: 120,
          total_tokens: Math.ceil(prompt.length / 4) + 120,
        },
      });
    }

    return error(res, 404, 'Not found');
  } catch (err) {
    console.error('openrouter stand-in:', err);
    if (!res.headersSent) error(res, 500, 'Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`openrouter stand-in (test double) on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
