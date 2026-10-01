import { spawn } from 'node:child_process';
import { createHash, createVerify, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBare, MAIN_REF, resolveCommit, isAncestor } from '../src/git/repo.ts';
import { commitFiles } from './helpers.ts';

/**
 * A stand-in GitHub for API tests (a test double: never used outside tests). It speaks the real
 * shapes of the calls DevSpace makes: the app's user authorization (PKCE, refresh rotation), the
 * REST endpoints, installation tokens (checking the app's JWT), and Git smart-HTTP through the
 * real `git http-backend`, checking the Authorization header like GitHub does.
 */

export interface StubCall {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

export interface StubPush {
  repo: string;
  auth: string | null;
  before: string | null;
  after: string | null;
  fastForward: boolean;
}

interface Repo {
  id: number;
  owner: string;
  ownerId: number;
  name: string;
  private: boolean;
  dir: string;
}

interface Installation {
  id: number;
  login: string;
  accountId: number;
  selection: 'all' | 'selected';
  repoIds: Set<number>;
}

export interface GithubStub {
  url: string;
  apiUrl: string;
  calls: StubCall[];
  pushes: StubPush[];
  /** Every token the stub handed out (user, refresh and installation tokens). */
  issuedTokens: string[];
  /** The login the next authorization signs in as. */
  nextLogin: string;
  /** Status codes to answer the next matching requests with (key: `METHOD path-prefix`). */
  failNext: Map<string, number>;
  /** Signs in like a browser: follows nothing, returns the redirect target. */
  login(authUrl: string): Promise<URL>;
  userId(login: string): number;
  /** Installs the app on `login`'s account. */
  install(login: string, selection?: 'all' | 'selected'): number;
  uninstall(login: string): void;
  /** Creates a repository (optionally with files) on `owner`, added to their installation. */
  createRepo(
    owner: string,
    name: string,
    options?: { private?: boolean; files?: Record<string, string> },
  ): Promise<Repo>;
  repo(fullName: string): Repo | undefined;
  /** A commit made "on GitHub" (on top of main). */
  commitOnGithub(fullName: string, files: Record<string, string>): Promise<string>;
  mainOf(fullName: string): Promise<string | null>;
  /** Makes every access token of `login` expire now (refresh still works). */
  expireTokens(login: string): void;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startGithubStub(options: {
  appId: string;
  clientId: string;
  clientSecret: string;
  publicKey: string;
}): Promise<GithubStub> {
  const root = mkdtempSync(join(tmpdir(), 'devspace-github-stub-'));
  let nextId = 1000;
  const users = new Map<string, number>();
  const userTokens = new Map<string, { login: string; expiresAt: number }>();
  const refreshTokens = new Map<string, string>();
  const codes = new Map<string, { login: string; challenge: string; redirectUri: string }>();
  const installations = new Map<number, Installation>();
  const repos = new Map<string, Repo>();
  const instTokens = new Map<
    string,
    { installationId: number; repoIds: number[]; write: boolean }
  >();
  const calls: StubCall[] = [];
  const pushes: StubPush[] = [];
  const issuedTokens: string[] = [];
  const failNext = new Map<string, number>();

  const token = (prefix: string) => {
    const t = `${prefix}_${randomBytes(18).toString('hex')}`;
    issuedTokens.push(t);
    return t;
  };
  const userIdOf = (login: string) => {
    let id = users.get(login);
    if (id === undefined) users.set(login, (id = nextId++));
    return id;
  };
  const installationOf = (login: string) =>
    [...installations.values()].find((i) => i.login === login);

  const issueUserTokens = (login: string) => {
    const access = token('ghu');
    const refresh = token('ghr');
    userTokens.set(access, { login, expiresAt: Date.now() + 8 * 3600_000 });
    refreshTokens.set(refresh, login);
    return {
      access_token: access,
      expires_in: 28800,
      refresh_token: refresh,
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
      scope: '',
    };
  };

  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const m = /^(?:Bearer|token)\s+(\S+)$/i.exec(h);
    return m ? m[1]! : null;
  };

  const verifyJwt = (jwt: string): boolean => {
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(options.publicKey, Buffer.from(parts[2]!, 'base64url'))) return false;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      iss?: unknown;
      exp?: number;
      iat?: number;
    };
    const now = Math.floor(Date.now() / 1000);
    return (
      String(payload.iss) === options.appId &&
      typeof payload.exp === 'number' &&
      payload.exp > now &&
      payload.exp - (payload.iat ?? 0) <= 660
    );
  };

  const repoJson = (r: Repo) => ({
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    private: r.private,
    visibility: r.private ? 'private' : 'public',
    html_url: `${stub.url}/${r.owner}/${r.name}`,
    clone_url: `${stub.url}/${r.owner}/${r.name}.git`,
    default_branch: 'main',
    size: 1,
    owner: { login: r.owner, id: r.ownerId },
  });

  async function createRepoInternal(owner: string, name: string, priv: boolean) {
    const dir = join(root, owner, `${name}.git`);
    mkdirSync(join(root, owner), { recursive: true });
    await initBare(dir);
    const repo: Repo = { id: nextId++, owner, ownerId: userIdOf(owner), name, private: priv, dir };
    repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    const repo = m ? repos.get(`${m[1]}/${m[2]}`.toLowerCase()) : undefined;
    if (!m || !repo) return send(res, 404, { message: 'Not Found' });
    const rest = m[3]!;
    const isPush =
      rest === '/git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
    // Auth: Basic x-access-token:<installation token covering the repo> (or Bearer).
    const header = req.headers.authorization ?? null;
    let tok: string | null = null;
    if (header?.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (user === 'x-access-token') tok = pass ?? null;
    } else tok = bearer(req);
    const grant = tok ? instTokens.get(tok) : undefined;
    const allowed = grant?.repoIds.includes(repo.id) && (!isPush || grant.write);
    if (!allowed && (repo.private || isPush)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
      res.end();
      return;
    }
    const body = await readBody(req);
    const before = isPush && req.method === 'POST' ? await resolveCommit(repo.dir, MAIN_REF) : null;
    const out = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/${repo.owner}/${repo.name}.git${rest}`,
          REQUEST_METHOD: req.method ?? 'GET',
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: (req.headers['content-encoding'] as string | undefined) ?? '',
          GIT_PROTOCOL: (req.headers['git-protocol'] as string | undefined) ?? '',
          REMOTE_USER: 'x-access-token',
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', reject);
      child.on('close', () => resolve(Buffer.concat(chunks)));
      child.stdin.end(body);
    });
    if (isPush && req.method === 'POST') {
      const after = await resolveCommit(repo.dir, MAIN_REF);
      pushes.push({
        repo: `${repo.owner}/${repo.name}`,
        auth: header,
        before,
        after,
        fastForward:
          !before || !after || before === after || (await isAncestor(repo.dir, before, after)),
      });
    }
    const split = out.indexOf('\r\n\r\n');
    const head = out.subarray(0, split).toString('utf8');
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(split + 4));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      if (/\.git\//.test(url.pathname)) return handleGit(req, res, url);
      const raw = await readBody(req);
      let body: unknown = null;
      const text = raw.toString('utf8');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = Object.fromEntries(new URLSearchParams(text));
        }
      }
      const auth = req.headers.authorization ?? null;
      calls.push({ method: req.method ?? '', path: url.pathname + url.search, auth, body });
      for (const [key, status] of failNext) {
        const [method, prefix] = key.split(' ');
        if (req.method === method && url.pathname.startsWith(prefix!)) {
          failNext.delete(key);
          return send(res, status, { message: 'Server Error' });
        }
      }
      const b = (body ?? {}) as Record<string, string | undefined>;

      // ----- Web: the app's user authorization -----
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        if (url.searchParams.get('client_id') !== options.clientId)
          return send(res, 400, { error: 'bad client' });
        if (url.searchParams.get('code_challenge_method') !== 'S256')
          return send(res, 400, { error: 'pkce' });
        const code = randomBytes(10).toString('hex');
        codes.set(code, {
          login: stub.nextLogin,
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: redirect,
        });
        const target = new URL(redirect);
        target.searchParams.set('code', code);
        target.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        if (b.client_id !== options.clientId || b.client_secret !== options.clientSecret) {
          return send(res, 200, { error: 'incorrect_client_credentials' });
        }
        if (b.grant_type === 'refresh_token') {
          const login = b.refresh_token ? refreshTokens.get(b.refresh_token) : undefined;
          if (!login) return send(res, 200, { error: 'bad_refresh_token' });
          refreshTokens.delete(b.refresh_token!);
          return send(res, 200, issueUserTokens(login));
        }
        const entry = b.code ? codes.get(b.code) : undefined;
        if (!entry) return send(res, 200, { error: 'bad_verification_code' });
        codes.delete(b.code!);
        const challenge = createHash('sha256')
          .update(b.code_verifier ?? '')
          .digest('base64url');
        if (challenge !== entry.challenge || b.redirect_uri !== entry.redirectUri) {
          return send(res, 200, { error: 'bad_verification_code' });
        }
        userIdOf(entry.login);
        return send(res, 200, issueUserTokens(entry.login));
      }

      // ----- REST -----
      const path = url.pathname.startsWith('/api/v3') ? url.pathname.slice(7) : null;
      if (path === null) return send(res, 404, { message: 'Not Found' });
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const paginate = <T>(list: T[]) => list.slice((page - 1) * perPage, page * perPage);

      if (path.startsWith('/app/')) {
        const jwt = bearer(req);
        if (!jwt || !verifyJwt(jwt))
          return send(res, 401, { message: 'A JSON web token could not be decoded' });
        const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
        if (req.method === 'POST' && m) {
          const inst = installations.get(Number(m[1]));
          if (!inst) return send(res, 404, { message: 'Not Found' });
          const ids = ((body as { repository_ids?: number[] } | null)?.repository_ids ?? []).map(
            Number,
          );
          const covered =
            inst.selection === 'all'
              ? ids.every((id) =>
                  [...repos.values()].some((r) => r.id === id && r.owner === inst.login),
                )
              : ids.every((id) => inst.repoIds.has(id));
          if (!covered)
            return send(res, 422, {
              message:
                'There is at least one repository that does not exist or is not accessible to the parent installation.',
            });
          const t = token('ghs');
          const perms = (body as { permissions?: { contents?: string } } | null)?.permissions;
          instTokens.set(t, {
            installationId: inst.id,
            repoIds: ids,
            write: perms?.contents !== 'read',
          });
          return send(res, 201, {
            token: t,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        return send(res, 404, { message: 'Not Found' });
      }

      const access = bearer(req);
      const session = access ? userTokens.get(access) : undefined;
      if (!session || session.expiresAt <= Date.now())
        return send(res, 401, { message: 'Bad credentials' });
      const login = session.login;

      if (req.method === 'GET' && path === '/user') {
        return send(res, 200, { id: userIdOf(login), login, name: login, type: 'User' });
      }
      if (req.method === 'GET' && path === '/user/installations') {
        const list = [...installations.values()].filter((i) => i.login === login);
        return send(res, 200, {
          total_count: list.length,
          installations: paginate(list).map((i) => ({
            id: i.id,
            app_id: Number(options.appId),
            account: { login: i.login, id: i.accountId },
            repository_selection: i.selection,
          })),
        });
      }
      let m = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (req.method === 'GET' && m) {
        const inst = installations.get(Number(m[1]));
        if (!inst || inst.login !== login) return send(res, 404, { message: 'Not Found' });
        const list = [...repos.values()].filter((r) =>
          inst.selection === 'all' ? r.owner === inst.login : inst.repoIds.has(r.id),
        );
        return send(res, 200, {
          total_count: list.length,
          repository_selection: inst.selection,
          repositories: paginate(list).map(repoJson),
        });
      }
      m = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(path);
      if (req.method === 'PUT' && m) {
        const inst = installations.get(Number(m[1]));
        const repo = [...repos.values()].find((r) => r.id === Number(m![2]));
        if (!inst || inst.login !== login || !repo || repo.owner !== login)
          return send(res, 404, { message: 'Not Found' });
        inst.repoIds.add(repo.id);
        return send(res, 204);
      }
      if (req.method === 'POST' && path === '/user/repos') {
        const name = String((body as { name?: unknown } | null)?.name ?? '');
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name))
          return send(res, 422, {
            message: 'Repository creation failed.',
            errors: [
              { resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' },
            ],
          });
        if (repos.has(`${login}/${name}`.toLowerCase())) {
          return send(res, 422, {
            message: 'Repository creation failed.',
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
        const priv = (body as { private?: unknown } | null)?.private !== false;
        const repo = await createRepoInternal(login, name, priv);
        return send(res, 201, repoJson(repo));
      }
      return send(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      console.error('github stub error', err);
      if (!res.headersSent) send(res, 500, { message: 'stub error' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const stub: GithubStub = {
    url: base,
    apiUrl: `${base}/api/v3`,
    calls,
    pushes,
    issuedTokens,
    nextLogin: 'octo-user',
    failNext,
    async login(authUrl) {
      const res = await fetch(authUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (!location) throw new Error(`authorize answered ${res.status}`);
      return new URL(location);
    },
    userId: userIdOf,
    install(login, selection = 'selected') {
      const existing = installationOf(login);
      if (existing) return existing.id;
      const id = nextId++;
      installations.set(id, {
        id,
        login,
        accountId: userIdOf(login),
        selection,
        repoIds: new Set(),
      });
      return id;
    },
    uninstall(login) {
      const i = installationOf(login);
      if (i) installations.delete(i.id);
    },
    async createRepo(owner, name, opts = {}) {
      const repo = await createRepoInternal(owner, name, opts.private ?? true);
      if (opts.files) await commitFiles(repo.dir, opts.files, 'Made on GitHub\n');
      installationOf(owner)?.repoIds.add(repo.id);
      return repo;
    },
    repo: (fullName) => repos.get(fullName.toLowerCase()),
    async commitOnGithub(fullName, files) {
      const repo = repos.get(fullName.toLowerCase());
      if (!repo) throw new Error('no such repo');
      return commitFiles(repo.dir, files, 'Edited on GitHub\n');
    },
    async mainOf(fullName) {
      const repo = repos.get(fullName.toLowerCase());
      return repo ? resolveCommit(repo.dir, MAIN_REF) : null;
    },
    expireTokens(login) {
      for (const t of userTokens.values()) if (t.login === login) t.expiresAt = Date.now() - 1;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
  return stub;
}
