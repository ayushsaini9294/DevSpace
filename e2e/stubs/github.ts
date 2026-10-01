// TEST DOUBLE — a stand-in for GitHub, used only by the e2e tests and CI (Phase 13 contract,
// section 8). It is NOT GitHub and never talks to it; it holds no real credentials. Playwright starts
// it (playwright.config.ts) with a throwaway GitHub App key made for each run, and points the API
// and worker at it with GITHUB_WEB_URL / GITHUB_API_URL. The owner's real check uses real GitHub.
//
// Web side (GITHUB_WEB_URL = http://127.0.0.1:<port>), real GitHub paths:
// - GET  /login/oauth/authorize?client_id&redirect_uri&state  the "authorize" page: a GitHub
//        username box (prefilled) and an "Authorize DevSpace" button, which goes back to
//        redirect_uri with `code` and `state` (the GitHub App's user authorization)
// - POST /login/oauth/access_token  code → user token (8 h) + refresh token (single use, rotated);
//        grant_type=refresh_token → new pair. Errors are 200 { error } like GitHub.
// - GET  /apps/<slug>/installations/new  the "install the app" page; installing covers no
//        repositories yet (repository_selection "selected"), so DevSpace must add each new repo.
// - git smart HTTP for /<owner>/<repo>.git, served by `git http-backend`. It needs an installation
//   token that covers the repo (Authorization: Basic x-access-token:<token>, or Bearer), and records
//   every ref update a push makes and whether it was a fast-forward. Like GitHub, a forced
//   (non-fast-forward) update is accepted, so a test sees it in both the record and the history.
//
// REST side (GITHUB_API_URL = <web>/api/v3, GitHub Enterprise style), real-shaped JSON:
// - user token: GET /user, POST /user/repos, GET /user/installations,
//   GET /user/installations/:id/repositories, PUT /user/installations/:id/repositories/:repoId,
//   GET /repos/:owner/:repo
// - app JWT (RS256, iss = app id): GET /app, GET /app/installations,
//   GET /users/:login/installation, GET /repos/:owner/:repo/installation,
//   POST /app/installations/:id/access_tokens
// - installation token: GET /installation/repositories, GET /repos/:owner/:repo
//
// Test-only (/__stub/…): health, requests (log, no tokens), POST repos (seed a repo),
// POST repos/:owner/:repo/commit (a commit "made on GitHub"), GET repos/:owner/:repo (main, its
// history and the pushes), POST users/:login/expire-tokens (forces a refresh).
//
// Run: node e2e/stubs/github.ts (Node 24 strips the types). Listens on 127.0.0.1 only. Or import
// startGithubStub() in a test.

import { execFileSync, spawn } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const API_PREFIX = '/api/v3';
const ZERO = '0000000000000000000000000000000000000000';
const USER_TOKEN_SECONDS = 8 * 3600;
const REFRESH_TOKEN_SECONDS = 15_897_600;
const INSTALLATION_TOKEN_SECONDS = 3600;

export type GithubStubOptions = {
  port?: number;
  appId?: string;
  appSlug?: string;
  clientId?: string;
  clientSecret?: string;
  /** The GitHub App's private key (PEM); the stand-in derives the public key to check JWTs. */
  privateKeyPath: string;
  /** Where the stand-in keeps its bare repositories; a fresh temporary folder by default. */
  dir?: string;
};

type GhUser = { id: number; login: string };
type UserToken = { login: string; expiresAt: number };
type RefreshToken = { login: string; expiresAt: number; used: boolean };
type Installation = {
  id: number;
  login: string;
  selection: 'selected' | 'all';
  repoIds: Set<number>;
};
type InstallationToken = {
  installationId: number;
  expiresAt: number;
  /** Set when the token was asked for with repository_ids: it reaches only those. */
  repoIds: Set<number> | null;
};
type RefUpdate = { old: string; new: string; ref: string; fastForward: boolean | null };
type Push = {
  at: string;
  /** Who pushed: always an installation token here (anything else is refused). */
  installationId: number;
  status: number;
  refs: RefUpdate[];
};
type Repo = {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  dir: string;
  createdAt: string;
  pushes: Push[];
};
type Logged = { at: string; method: string; path: string; status: number; auth?: string };

function ownerKey(owner: string, name: string) {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function json(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function apiError(res: ServerResponse, status: number, message: string, extra = {}) {
  json(res, status, {
    message,
    documentation_url: 'https://docs.github.com/rest',
    ...extra,
  });
}

function page(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<p><strong>Stand-in GitHub (test double).</strong> This page is part of DevSpace's automated tests. It is not GitHub.</p>
${body}
</body></html>`);
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON or form fields from a request body (GitHub accepts both on its token endpoint). */
async function readFields(req: IncomingMessage): Promise<Record<string, string>> {
  const text = await readBody(req);
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[k] = String(v);
        }
      }
      return out;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function base64urlJson(part: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** GitHub's repository name rules (letters, digits, '.', '-', '_'; at most 100). */
function validRepoName(name: string) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';
}

export function startGithubStub(options: GithubStubOptions) {
  const port = options.port ?? 4020;
  const appId = String(options.appId ?? '1001');
  const appSlug = options.appSlug ?? 'devspace-stand-in';
  const clientId = options.clientId ?? 'Iv1.standin';
  const clientSecret = options.clientSecret ?? '';
  const publicKey: KeyObject = createPublicKey(
    createPrivateKey(readFileSync(options.privateKeyPath, 'utf8')),
  );
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'devspace-github-stub-'));
  const reposRoot = join(dir, 'repos');
  mkdirSync(reposRoot, { recursive: true });
  const ownsDir = !options.dir;

  const webUrl = `http://${HOST}:${port}`;
  let nextId = 5000;
  const users = new Map<string, GhUser>(); // lowercase login →
  const codes = new Map<
    string,
    {
      login: string;
      redirectUri: string;
      used: boolean;
      expiresAt: number;
      /** PKCE (S256), when the authorize link carried one. */
      challenge: string;
    }
  >();
  const userTokens = new Map<string, UserToken>();
  const refreshTokens = new Map<string, RefreshToken>();
  const installations = new Map<number, Installation>();
  const installationTokens = new Map<string, InstallationToken>();
  const repos = new Map<string, Repo>();
  const log: Logged[] = [];

  const now = () => Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  function userFor(login: string): GhUser {
    const key = login.toLowerCase();
    let user = users.get(key);
    if (!user) {
      user = { id: nextId++, login };
      users.set(key, user);
    }
    return user;
  }

  function installationFor(login: string) {
    for (const inst of installations.values()) {
      if (inst.login.toLowerCase() === login.toLowerCase()) return inst;
    }
    return null;
  }

  function covers(inst: Installation, repo: Repo) {
    if (inst.login.toLowerCase() !== repo.owner.toLowerCase()) return false;
    return inst.selection === 'all' || inst.repoIds.has(repo.id);
  }

  function git(repoDir: string, args: string[], input?: string, env: Record<string, string> = {}) {
    return execFileSync('git', ['-c', 'core.hooksPath=hooks', ...args], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        GIT_DIR: repoDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    }).replace(/\n$/, '');
  }

  function mainOf(repo: Repo) {
    try {
      return git(repo.dir, ['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}']) || null;
    } catch {
      return null;
    }
  }

  /** Adds a commit on main (or the first one) with one file, as a person would on GitHub. */
  function commitOnMain(repo: Repo, path: string, content: string, message: string) {
    const parent = mainOf(repo);
    const blob = git(repo.dir, ['hash-object', '-w', '--stdin', '--no-filters'], content);
    const temp = mkdtempSync(join(tmpdir(), 'devspace-github-stub-index-'));
    let tree: string;
    try {
      const env = { GIT_INDEX_FILE: join(temp, 'index') };
      if (parent) git(repo.dir, ['read-tree', parent], undefined, env);
      git(
        repo.dir,
        ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
        undefined,
        env,
      );
      tree = git(repo.dir, ['write-tree'], undefined, env);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    const who = {
      GIT_AUTHOR_NAME: 'Someone on GitHub',
      GIT_AUTHOR_EMAIL: '1+someone@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'GitHub',
      GIT_COMMITTER_EMAIL: 'noreply@github.com',
    };
    const commit = git(
      repo.dir,
      ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      undefined,
      who,
    );
    git(repo.dir, ['update-ref', 'refs/heads/main', commit, parent ?? ZERO]);
    return commit;
  }

  function createRepo(owner: string, name: string, isPrivate: boolean, autoInit: boolean) {
    const repoDir = join(reposRoot, owner.toLowerCase(), `${name.toLowerCase()}.git`);
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', repoDir], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    git(repoDir, ['config', 'http.receivepack', 'true']);
    // Records each ref update and whether it is a fast-forward; accepts everything, like GitHub
    // does for a forced push, so a force shows up in the history as well as in the record.
    const hook = join(repoDir, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh
while read old new ref; do
  if [ "$old" = "${ZERO}" ] || [ "$new" = "${ZERO}" ]; then ff=none
  elif git merge-base --is-ancestor "$old" "$new"; then ff=yes
  else ff=no
  fi
  echo "$old $new $ref $ff" >> stub-ref-updates.log
done
exit 0
`,
    );
    chmodSync(hook, 0o755);
    const repo: Repo = {
      id: nextId++,
      owner: userFor(owner).login,
      name,
      private: isPrivate,
      dir: repoDir,
      createdAt: iso(now()),
      pushes: [],
    };
    repos.set(ownerKey(owner, name), repo);
    if (autoInit) commitOnMain(repo, 'README.md', `# ${name}\n`, 'Initial commit');
    return repo;
  }

  function repoView(repo: Repo) {
    const owner = userFor(repo.owner);
    return {
      id: repo.id,
      node_id: `R_stub${repo.id}`,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      visibility: repo.private ? 'private' : 'public',
      owner: { login: owner.login, id: owner.id, type: 'User' },
      html_url: `${webUrl}/${repo.owner}/${repo.name}`,
      clone_url: `${webUrl}/${repo.owner}/${repo.name}.git`,
      url: `${webUrl}${API_PREFIX}/repos/${repo.owner}/${repo.name}`,
      default_branch: 'main',
      size: sizeKb(repo),
      created_at: repo.createdAt,
      pushed_at: repo.pushes.at(-1)?.at ?? null,
      permissions: { admin: true, push: true, pull: true },
    };
  }

  function installationView(inst: Installation) {
    const account = userFor(inst.login);
    return {
      id: inst.id,
      app_id: Number(appId),
      app_slug: appSlug,
      target_type: 'User',
      account: { login: account.login, id: account.id, type: 'User' },
      repository_selection: inst.selection,
      permissions: { contents: 'write', metadata: 'read', administration: 'write' },
      html_url: `${webUrl}/settings/installations/${inst.id}`,
    };
  }

  function authToken(req: IncomingMessage) {
    const header = req.headers.authorization ?? '';
    const bearer = /^(?:Bearer|token) (\S+)$/i.exec(header);
    if (bearer) return bearer[1]!;
    const basic = /^Basic (\S+)$/i.exec(header);
    if (basic) {
      const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon >= 0 ? decoded.slice(colon + 1) : decoded;
    }
    return null;
  }

  function userFromToken(token: string | null) {
    if (!token) return null;
    const t = userTokens.get(token);
    return t && t.expiresAt > now() ? userFor(t.login) : null;
  }

  type Grant = { inst: Installation; repoIds: Set<number> | null };

  function installationFromToken(token: string | null): Grant | null {
    if (!token) return null;
    const t = installationTokens.get(token);
    if (!t || t.expiresAt <= now()) return null;
    const inst = installations.get(t.installationId);
    return inst ? { inst, repoIds: t.repoIds } : null;
  }

  /** The installation covers the repo, and the token wasn't limited to other repositories. */
  function grantCovers(grant: Grant, repo: Repo) {
    return covers(grant.inst, repo) && (!grant.repoIds || grant.repoIds.has(repo.id));
  }

  /** GitHub's per_page / page pagination (default 30, at most 100). */
  function paginate<T>(items: T[], params: URLSearchParams) {
    const perPage = Math.min(100, Math.max(1, Number(params.get('per_page')) || 30));
    const pageNo = Math.max(1, Number(params.get('page')) || 1);
    return items.slice((pageNo - 1) * perPage, pageNo * perPage);
  }

  /** The repository's size in KB, as GitHub reports it. */
  function sizeKb(repo: Repo) {
    try {
      const out = git(repo.dir, ['count-objects', '-v']);
      const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(out)?.[1]);
      return (field('size') || 0) + (field('size-pack') || 0);
    } catch {
      return 0;
    }
  }

  /** True when the request carries a valid app JWT (RS256, signed by the app's key). */
  function appJwt(token: string | null) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const header = base64urlJson(h);
    const payload = base64urlJson(p);
    if (header?.alg !== 'RS256' || !payload) return false;
    const ok = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) return false;
    const seconds = Math.floor(now() / 1000);
    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    return (
      String(payload.iss) === appId &&
      Number.isFinite(iat) &&
      Number.isFinite(exp) &&
      exp > seconds &&
      iat <= seconds + 60 &&
      exp - iat <= 660
    );
  }

  function issueUserTokens(login: string) {
    const access = `ghu_${randomBytes(18).toString('hex')}`;
    const refresh = `ghr_${randomBytes(30).toString('hex')}`;
    userTokens.set(access, { login, expiresAt: now() + USER_TOKEN_SECONDS * 1000 });
    refreshTokens.set(refresh, {
      login,
      expiresAt: now() + REFRESH_TOKEN_SECONDS * 1000,
      used: false,
    });
    return {
      access_token: access,
      expires_in: USER_TOKEN_SECONDS,
      refresh_token: refresh,
      refresh_token_expires_in: REFRESH_TOKEN_SECONDS,
      token_type: 'bearer',
      scope: '',
    };
  }

  function tokenAnswer(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
    const accept = req.headers.accept ?? '';
    if (accept.includes('application/json')) return json(res, 200, body);
    res.writeHead(200, { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' });
    res.end(new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString());
  }

  // ---------- git smart HTTP (git http-backend) ----------

  async function serveGit(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    repo: Repo,
    rest: string,
    entry: Logged,
  ) {
    const service =
      rest === '/info/refs' ? url.searchParams.get('service') : rest.replace(/^\//, '');
    const isPush = service === 'git-receive-pack';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return apiError(res, 404, 'Not Found');
    }
    const token = authToken(req);
    const grant = installationFromToken(token);
    const inst = grant?.inst ?? null;
    entry.auth = token ? (inst ? 'installation' : 'invalid') : 'none';
    if (!inst && (isPush || repo.private)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="GitHub"',
        'Content-Type': 'text/plain',
      });
      return res.end('Invalid username or token.\n');
    }
    if (grant && !grantCovers(grant, repo)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`Permission to ${repo.owner}/${repo.name}.git denied to ${appSlug}[bot].\n`);
    }

    const logFile = join(repo.dir, 'stub-ref-updates.log');
    if (isPush && req.method === 'POST') rmSync(logFile, { force: true });

    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: reposRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: `/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}.git${rest}`,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: inst ? `${appSlug}[bot]` : '',
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }
          : {}),
        ...(req.headers['git-protocol']
          ? { GIT_PROTOCOL: String(req.headers['git-protocol']) }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    req.pipe(child.stdin);
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`github stand-in git: ${d}`));

    let head = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n');
      let sep = 4;
      if (end < 0) {
        end = head.indexOf('\n\n');
        sep = 2;
      }
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + sep));
    });
    await new Promise<void>((resolve) => {
      child.on('close', () => {
        if (!headersDone) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end();
        resolve();
      });
    });

    if (isPush && req.method === 'POST' && inst) {
      const refs: RefUpdate[] = existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [old, next, ref, ff] = line.split(' ') as [string, string, string, string];
              return {
                old,
                new: next,
                ref,
                fastForward: ff === 'yes' ? true : ff === 'no' ? false : null,
              };
            })
        : [];
      rmSync(logFile, { force: true });
      repo.pushes.push({
        at: iso(now()),
        installationId: inst.id,
        status: res.statusCode,
        refs,
      });
    }
  }

  // ---------- REST API ----------

  async function serveApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    params: URLSearchParams,
  ) {
    const method = req.method ?? 'GET';
    const token = authToken(req);
    const user = userFromToken(token);
    const grant = installationFromToken(token);
    const inst = grant?.inst ?? null;
    const isApp = !user && !inst && appJwt(token);
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/app') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      return json(res, 200, {
        id: Number(appId),
        slug: appSlug,
        name: 'DevSpace (stand-in)',
        html_url: `${webUrl}/apps/${appSlug}`,
      });
    }
    if (method === 'GET' && path === '/app/installations') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      return json(res, 200, [...installations.values()].map(installationView));
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      const found = installations.get(Number(m[1]));
      if (!found) return apiError(res, 404, 'Not Found');
      const body = await readJsonBody(req);
      let repoIds: Set<number> | null = null;
      if (Array.isArray(body?.repository_ids)) {
        repoIds = new Set((body.repository_ids as unknown[]).map(Number));
        for (const id of repoIds) {
          const repo = [...repos.values()].find((r) => r.id === id);
          if (!repo || !covers(found, repo)) {
            return apiError(
              res,
              422,
              'There is at least one repository that does not exist or is not accessible to the parent installation.',
            );
          }
        }
      }
      const value = `ghs_${randomBytes(18).toString('hex')}`;
      const expiresAt = now() + INSTALLATION_TOKEN_SECONDS * 1000;
      installationTokens.set(value, { installationId: found.id, expiresAt, repoIds });
      return json(res, 201, {
        token: value,
        expires_at: iso(expiresAt),
        permissions: { contents: 'write', metadata: 'read' },
        repository_selection: found.selection,
      });
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(path)) && method === 'GET') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      const found = installations.get(Number(m[1]));
      return found ? json(res, 200, installationView(found)) : apiError(res, 404, 'Not Found');
    }
    if ((m = /^\/users\/([^/]+)\/installation$/.exec(path)) && method === 'GET') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      const found = installationFor(decodeURIComponent(m[1]!));
      return found ? json(res, 200, installationView(found)) : apiError(res, 404, 'Not Found');
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path)) && method === 'GET') {
      if (!isApp) return apiError(res, 401, 'A JSON web token could not be decoded');
      const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      const found = repo ? installationFor(repo.owner) : null;
      return found && repo && covers(found, repo)
        ? json(res, 200, installationView(found))
        : apiError(res, 404, 'Not Found');
    }

    if (method === 'GET' && path === '/installation/repositories') {
      if (!grant || !inst) return apiError(res, 401, 'Bad credentials');
      const list = [...repos.values()].filter((r) => grantCovers(grant, r)).map(repoView);
      return json(res, 200, {
        total_count: list.length,
        repository_selection: inst.selection,
        repositories: paginate(list, params),
      });
    }

    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)) && method === 'GET') {
      if (!user && !inst && token) return apiError(res, 401, 'Bad credentials');
      const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      const visible =
        repo &&
        (!repo.private ||
          (user && user.login.toLowerCase() === repo.owner.toLowerCase()) ||
          (grant && grantCovers(grant, repo)));
      return visible ? json(res, 200, repoView(repo)) : apiError(res, 404, 'Not Found');
    }

    // Everything below needs the user's token.
    if (!user) return apiError(res, 401, 'Bad credentials');

    if (method === 'GET' && path === '/user') {
      return json(res, 200, {
        login: user.login,
        id: user.id,
        node_id: `U_stub${user.id}`,
        type: 'User',
        name: `${user.login} (stand-in)`,
        email: null,
        html_url: `${webUrl}/${user.login}`,
        avatar_url: `${webUrl}/avatars/${user.id}`,
      });
    }
    if (method === 'POST' && path === '/user/repos') {
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!validRepoName(name)) {
        return apiError(res, 422, 'Repository creation failed.', {
          errors: [
            { resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' },
          ],
        });
      }
      if (repos.has(ownerKey(user.login, name))) {
        return apiError(res, 422, 'Repository creation failed.', {
          errors: [
            {
              resource: 'Repository',
              code: 'custom',
              field: 'name',
              message: 'name already exists on this account',
            },
          ],
        });
      }
      const repo = createRepo(user.login, name, body?.private === true, body?.auto_init === true);
      return json(res, 201, repoView(repo));
    }
    if (method === 'GET' && path === '/user/installations') {
      const mine = installationFor(user.login);
      return json(res, 200, {
        total_count: mine ? 1 : 0,
        installations: paginate(mine ? [installationView(mine)] : [], params),
      });
    }
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(path)) && method === 'GET') {
      const found = installations.get(Number(m[1]));
      if (!found || found.login.toLowerCase() !== user.login.toLowerCase()) {
        return apiError(res, 404, 'Not Found');
      }
      const list = [...repos.values()].filter((r) => covers(found, r)).map(repoView);
      return json(res, 200, {
        total_count: list.length,
        repository_selection: found.selection,
        repositories: paginate(list, params),
      });
    }
    if (
      (m = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(path)) &&
      (method === 'PUT' || method === 'DELETE')
    ) {
      const found = installations.get(Number(m[1]));
      const repo = [...repos.values()].find((r) => r.id === Number(m![2]));
      if (!found || !repo || found.login.toLowerCase() !== user.login.toLowerCase()) {
        return apiError(res, 404, 'Not Found');
      }
      if (repo.owner.toLowerCase() !== found.login.toLowerCase()) {
        return apiError(res, 422, 'The repository is not owned by the installation account');
      }
      if (method === 'PUT') found.repoIds.add(repo.id);
      else found.repoIds.delete(repo.id);
      res.writeHead(204);
      return res.end();
    }

    return apiError(res, 404, 'Not Found');
  }

  // ---------- web pages and OAuth ----------

  function cookieLogin(req: IncomingMessage) {
    const match = /(?:^|;\s*)stub_github_login=([^;]+)/.exec(req.headers.cookie ?? '');
    return match ? decodeURIComponent(match[1]!) : '';
  }

  async function serveWeb(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (path === '/login/oauth/authorize' && method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (url.searchParams.get('client_id') !== clientId) {
        return page(res, 404, 'Not found', '<h1>Unknown client_id</h1>');
      }
      const suggested = cookieLogin(req) || `octo-${randomBytes(4).toString('hex')}`;
      const challengeMethod = url.searchParams.get('code_challenge_method');
      if (url.searchParams.get('code_challenge') && challengeMethod !== 'S256') {
        return page(res, 400, 'Bad request', '<h1>Only code_challenge_method=S256</h1>');
      }
      const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge']
        .map(
          (k) =>
            `<input type="hidden" name="${k}" value="${escapeHtml(url.searchParams.get(k) ?? '')}">`,
        )
        .join('\n');
      return page(
        res,
        200,
        'Authorize DevSpace (stand-in)',
        `<h1>Authorize DevSpace</h1>
<p>Redirects to ${escapeHtml(redirectUri || '(the app’s callback URL)')}</p>
<form method="post" action="/login/oauth/authorize">
${hidden}
<label>GitHub username <input name="login" value="${escapeHtml(suggested)}" pattern="[A-Za-z0-9-]{1,39}" required></label>
<button type="submit">Authorize DevSpace</button>
</form>`,
      );
    }
    if (path === '/login/oauth/authorize' && method === 'POST') {
      const form = await readFields(req);
      const login = (form.login ?? '').trim();
      if (form.client_id !== clientId || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
        return page(res, 400, 'Bad request', '<h1>Bad request</h1>');
      }
      let target: URL;
      try {
        target = new URL(form.redirect_uri ?? '');
      } catch {
        return page(res, 400, 'Bad request', '<h1>redirect_uri is missing or invalid</h1>');
      }
      if (!/^(localhost|127\.0\.0\.1)$/.test(target.hostname) && target.protocol !== 'https:') {
        return page(res, 400, 'Bad request', '<h1>redirect_uri must be https or localhost</h1>');
      }
      userFor(login);
      const code = randomBytes(10).toString('hex');
      codes.set(code, {
        login,
        redirectUri: target.toString(),
        used: false,
        expiresAt: now() + 10 * 60_000,
        challenge: form.code_challenge ?? '',
      });
      target.searchParams.set('code', code);
      if (form.state) target.searchParams.set('state', form.state);
      res.writeHead(302, {
        Location: target.toString(),
        'Set-Cookie': `stub_github_login=${encodeURIComponent(login)}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return res.end();
    }

    if (path === '/login/oauth/access_token' && method === 'POST') {
      const fields = { ...Object.fromEntries(url.searchParams), ...(await readFields(req)) };
      if (fields.client_id !== clientId || fields.client_secret !== clientSecret) {
        return tokenAnswer(req, res, {
          error: 'incorrect_client_credentials',
          error_description: 'The client_id and/or client_secret passed are incorrect.',
        });
      }
      if (fields.grant_type === 'refresh_token') {
        const refresh = refreshTokens.get(fields.refresh_token ?? '');
        if (!refresh || refresh.used || refresh.expiresAt <= now()) {
          return tokenAnswer(req, res, {
            error: 'bad_refresh_token',
            error_description: 'The refresh token passed is incorrect or expired.',
          });
        }
        refresh.used = true;
        return tokenAnswer(req, res, issueUserTokens(refresh.login));
      }
      const pending = codes.get(fields.code ?? '');
      if (
        !pending ||
        pending.used ||
        pending.expiresAt <= now() ||
        (fields.redirect_uri && fields.redirect_uri !== pending.redirectUri.split('?')[0])
      ) {
        return tokenAnswer(req, res, {
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        });
      }
      pending.used = true;
      if (
        pending.challenge &&
        createHash('sha256')
          .update(fields.code_verifier ?? '')
          .digest('base64url') !== pending.challenge
      ) {
        return tokenAnswer(req, res, {
          error: 'bad_verification_code',
          error_description: 'The code_verifier does not match the code_challenge.',
        });
      }
      return tokenAnswer(req, res, issueUserTokens(pending.login));
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/apps\/([^/]+)\/installations\/new$/.exec(path))) {
      if (m[1] !== appSlug) return page(res, 404, 'Not found', '<h1>Unknown app</h1>');
      if (method === 'GET') {
        const login = cookieLogin(req);
        return page(
          res,
          200,
          'Install DevSpace (stand-in)',
          `<h1>Install DevSpace</h1>
<form method="post">
<label>Account <input name="login" value="${escapeHtml(login)}" pattern="[A-Za-z0-9-]{1,39}" required></label>
<p>Repository access: only select repositories.</p>
<button type="submit">Install</button>
</form>`,
        );
      }
      if (method === 'POST') {
        const form = await readFields(req);
        const login = (form.login ?? '').trim();
        if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
          return page(res, 400, 'Bad request', '<h1>Bad request</h1>');
        }
        const account = userFor(login);
        let found = installationFor(login);
        if (!found) {
          found = { id: nextId++, login: account.login, selection: 'selected', repoIds: new Set() };
          installations.set(found.id, found);
        }
        return page(
          res,
          200,
          'Installed (stand-in)',
          `<h1>Installed</h1><p data-installation-id="${found.id}">DevSpace is installed on ${escapeHtml(account.login)}. You can go back to DevSpace.</p>`,
        );
      }
    }

    // Repository pages and git: /<owner>/<repo> and /<owner>/<repo>.git/...
    if (
      (m =
        /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/info\/refs|\/git-upload-pack|\/git-receive-pack)?$/.exec(
          path,
        ))
    ) {
      const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      if (!repo) return page(res, 404, 'Not found', '<h1>404</h1>');
      if (m[3]) return 'git';
      if (repo.private) return page(res, 404, 'Not found', '<h1>404</h1>');
      return page(
        res,
        200,
        `${repo.owner}/${repo.name}`,
        `<h1>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</h1><p>main: ${mainOf(repo) ?? '(empty)'}</p>`,
      );
    }
    return page(res, 404, 'Not found', '<h1>404</h1>');
  }

  // ---------- test-only controls ----------

  async function serveControl(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/__stub/health') return json(res, 200, { ok: true });
    if (method === 'GET' && path === '/__stub/requests') return json(res, 200, { requests: log });
    if (method === 'POST' && path === '/__stub/repos') {
      const body = await readJsonBody(req);
      const owner = typeof body?.owner === 'string' ? body.owner : '';
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !validRepoName(name)) {
        return apiError(res, 422, 'owner and name are required');
      }
      if (repos.has(ownerKey(owner, name))) return apiError(res, 422, 'name already exists');
      const repo = createRepo(owner, name, body?.private !== false, false);
      const files =
        body?.files && typeof body.files === 'object'
          ? Object.entries(body.files as Record<string, unknown>)
          : [];
      for (const [p, content] of files) {
        commitOnMain(repo, p, String(content), `Add ${p}`);
      }
      // Seeded repositories are covered by the owner's installation, if there is one.
      installationFor(owner)?.repoIds.add(repo.id);
      return json(res, 201, { ...repoView(repo), main: mainOf(repo) });
    }
    if ((m = /^\/__stub\/repos\/([^/]+)\/([^/]+)\/commit$/.exec(path)) && method === 'POST') {
      const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      if (!repo) return apiError(res, 404, 'Not Found');
      const body = await readJsonBody(req);
      const p = typeof body?.path === 'string' ? body.path : 'CHANGED_ON_GITHUB.md';
      const content = typeof body?.content === 'string' ? body.content : 'Changed on GitHub\n';
      const message = typeof body?.message === 'string' ? body.message : `Update ${p}`;
      return json(res, 201, { sha: commitOnMain(repo, p, content, message) });
    }
    if ((m = /^\/__stub\/repos\/([^/]+)\/([^/]+)$/.exec(path)) && method === 'GET') {
      const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      if (!repo) return json(res, 404, { exists: false });
      const main = mainOf(repo);
      const history = main ? git(repo.dir, ['rev-list', main]).split('\n').filter(Boolean) : [];
      const inst = installationFor(repo.owner);
      return json(res, 200, {
        exists: true,
        ...repoView(repo),
        main,
        log: history,
        refs: git(repo.dir, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean),
        coveredByInstallation: inst ? covers(inst, repo) : false,
        pushes: repo.pushes,
      });
    }
    if ((m = /^\/__stub\/users\/([^/]+)\/expire-tokens$/.exec(path)) && method === 'POST') {
      const login = decodeURIComponent(m[1]!).toLowerCase();
      let expired = 0;
      for (const t of userTokens.values()) {
        if (t.login.toLowerCase() === login && t.expiresAt > now()) {
          t.expiresAt = now() - 1;
          expired++;
        }
      }
      return json(res, 200, { expired });
    }
    return apiError(res, 404, 'Not Found');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', webUrl);
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
      if (url.pathname.startsWith('/__stub/')) return await serveControl(req, res, url.pathname);
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        const token = authToken(req);
        entry.auth = !token
          ? 'none'
          : userTokens.has(token)
            ? 'user'
            : installationTokens.has(token)
              ? 'installation'
              : token.split('.').length === 3
                ? 'jwt'
                : 'invalid';
        return await serveApi(
          req,
          res,
          url.pathname.slice(API_PREFIX.length) || '/',
          url.searchParams,
        );
      }
      const web = await serveWeb(req, res, url);
      if (web === 'git') {
        const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)$/.exec(url.pathname)!;
        const repo = repos.get(ownerKey(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)))!;
        return await serveGit(req, res, url, repo, m[3]!, entry);
      }
    } catch (err) {
      console.error('github stand-in:', err);
      if (!res.headersSent) apiError(res, 500, 'Internal error');
      else res.end();
    }
  });

  const ready = new Promise<void>((resolve) => server.listen(port, HOST, resolve));
  return {
    url: webUrl,
    apiUrl: `${webUrl}${API_PREFIX}`,
    ready,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          if (ownsDir) rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!keyPath) {
    console.error('github stand-in: GITHUB_APP_PRIVATE_KEY_PATH is required (a throwaway key)');
    process.exit(1);
  }
  const stub = startGithubStub({
    port: Number(process.env.GITHUB_STUB_PORT || 4020),
    appId: process.env.GITHUB_APP_ID,
    appSlug: process.env.GITHUB_APP_SLUG,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    privateKeyPath: keyPath,
  });
  void stub.ready.then(() => console.log(`github stand-in (test double) on ${stub.url}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void stub.close().then(() => process.exit(0)));
  }
}
