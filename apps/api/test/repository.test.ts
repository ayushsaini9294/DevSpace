import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ActivityListResponseSchema,
  FileResponseSchema,
  MAX_FILE_VIEW_BYTES,
  RepositoryResponseSchema,
  TreeResponseSchema,
  type RepositoryStatus,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { prisma } from '../src/lib/prisma.ts';
import { GitError, runGit } from '../src/git/run.ts';
import { MAIN_REF, refExists } from '../src/git/repo.ts';
import { INTERRUPTED_MESSAGE, recoverInterruptedImports } from '../src/repository/import.ts';
import { importTempDir, repoDir } from '../src/repository/storage.ts';
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

afterAll(cleanUp);

async function newProject(name = 'Repo Project') {
  const leader = await signUp('Lena Leader');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, name);
  return { leader, team, project };
}

async function status(user: TestUser, projectId: string): Promise<RepositoryStatus> {
  const res = await as(user).get(`/api/projects/${projectId}/repository`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return RepositoryResponseSchema.parse(res.body).repository;
}

async function setUpEmpty(user: TestUser, projectId: string) {
  const res = await as(user).post(`/api/projects/${projectId}/repository`, { source: 'empty' });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return RepositoryResponseSchema.parse(res.body).repository;
}

async function repoPathOf(projectId: string): Promise<string> {
  const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  expect(row.repoPath).toBeTruthy();
  return row.repoPath!;
}

const tree = (user: TestUser, projectId: string, path?: string) =>
  as(user).get(
    `/api/projects/${projectId}/tree${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`,
  );
const file = (user: TestUser, projectId: string, path: string) =>
  as(user).get(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`);

async function waitWhileImporting(user: TestUser, projectId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await status(user, projectId);
    if (current.status !== 'importing') return current;
    if (Date.now() > deadline) throw new Error('import did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('empty repository', () => {
  it('starts with no repository, and routes that need one answer 409', async () => {
    const { leader, project } = await newProject();
    expect(await status(leader, project.id)).toEqual({
      status: 'none',
      source: null,
      template: null,
      importUrl: null,
      error: null,
      lastCommit: null,
    });
    expectError(await tree(leader, project.id), 409, 'repository_not_ready');
    expectError(await file(leader, project.id, 'README.md'), 409, 'repository_not_ready');
  });

  it('creates main with a README credited to the leader; tree and file show it; no second setup', async () => {
    const { leader, project } = await newProject('Moon Base');
    const created = await setUpEmpty(leader, project.id);
    expect(created.status).toBe('ready');
    expect(created.source).toBe('empty');
    expect(created.lastCommit?.authorName).toBe('Lena Leader');
    expect(created.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/);

    // The repository is a real bare repo in REPOS_DIR with main, authored and committed by the user.
    const gitDir = await repoPathOf(project.id);
    expect(gitDir).toBe(join(env.REPOS_DIR, `${project.id}.git`));
    expect(await refExists(gitDir, MAIN_REF)).toBe(true);
    const log = await runGit(['log', '-1', '--format=%an|%ae|%cn|%ce', MAIN_REF, '--'], { gitDir });
    expect(log.stdout.toString().trim()).toBe(
      `Lena Leader|${leader.email}|Lena Leader|${leader.email}`,
    );
    const head = await runGit(['symbolic-ref', 'HEAD'], { gitDir });
    expect(head.stdout.toString().trim()).toBe(MAIN_REF);

    const listing = await tree(leader, project.id);
    expect(listing.status).toBe(200);
    expect(TreeResponseSchema.parse(listing.body)).toEqual({
      path: '',
      entries: [{ name: 'README.md', path: 'README.md', type: 'file', size: 12 }],
    });
    const readme = await file(leader, project.id, 'README.md');
    expect(readme.status).toBe(200);
    expect(FileResponseSchema.parse(readme.body)).toEqual({
      path: 'README.md',
      size: 12,
      isBinary: false,
      tooLarge: false,
      content: '# Moon Base\n',
    });

    expectError(
      await as(leader).post(`/api/projects/${project.id}/repository`, { source: 'empty' }),
      409,
      'repository_exists',
    );
    expectError(
      await as(leader).post(`/api/projects/${project.id}/repository`, {
        source: 'import',
        url: 'https://github.com/octocat/Hello-World',
      }),
      409,
      'repository_exists',
    );

    const activity = await as(leader).get(`/api/projects/${project.id}/activity`);
    const entries = ActivityListResponseSchema.parse(activity.body).entries;
    expect(entries.find((e) => e.action === 'repository.created')?.data).toEqual({
      source: 'empty',
    });
  });

  it('rejects a bad setup body', async () => {
    const { leader, project } = await newProject();
    for (const body of [{}, { source: 'zip' }, { source: 'import' }]) {
      expectError(
        await as(leader).post(`/api/projects/${project.id}/repository`, body),
        400,
        'validation_error',
      );
    }
    expect((await status(leader, project.id)).status).toBe('none');
  });
});

describe('who can see and set up the repository', () => {
  it('members read tree and file but cannot set up; co-leaders can; outsiders get 404', async () => {
    const { leader, project } = await newProject();
    const member = await signUp('Mia Member');
    const coLeader = await signUp('Cole Co');
    const outsider = await signUp('Otto Outsider');
    await addMember(leader, project.id, member);
    await addMember(leader, project.id, coLeader);
    const promote = await as(leader).patch(`/api/projects/${project.id}/members/${coLeader.id}`, {
      role: 'co_leader',
    });
    expect(promote.status).toBe(200);

    expectError(
      await as(member).post(`/api/projects/${project.id}/repository`, { source: 'empty' }),
      403,
      'forbidden',
    );
    await setUpEmpty(coLeader, project.id);
    expect((await status(member, project.id)).lastCommit?.authorName).toBe('Cole Co');
    expect((await tree(member, project.id)).status).toBe(200);
    expect((await file(member, project.id, 'README.md')).status).toBe(200);

    expectError(await as(outsider).get(`/api/projects/${project.id}/repository`), 404, 'not_found');
    expectError(
      await as(outsider).post(`/api/projects/${project.id}/repository`, { source: 'empty' }),
      404,
      'not_found',
    );
    expectError(await tree(outsider, project.id), 404, 'not_found');
    expectError(await file(outsider, project.id, 'README.md'), 404, 'not_found');
  });
});

describe('browsing main', () => {
  it('validates paths, and 404s for missing paths or the wrong kind of entry', async () => {
    const { leader, project } = await newProject();
    await setUpEmpty(leader, project.id);
    await commitFiles(await repoPathOf(project.id), {
      'README.md': '# hi\n',
      'src/index.ts': 'export {};\n',
    });

    for (const bad of ['../x', '/etc/passwd', 'a\\b', 'src/', 'src//index.ts', './src', 'a\nb']) {
      expectError(await tree(leader, project.id, bad), 400, 'validation_error');
      expectError(await file(leader, project.id, bad), 400, 'validation_error');
    }
    expectError(
      await as(leader).get(`/api/projects/${project.id}/tree?path=a&path=b`),
      400,
      'validation_error',
    );
    expectError(await as(leader).get(`/api/projects/${project.id}/file`), 400, 'validation_error');

    expectError(await tree(leader, project.id, 'missing'), 404, 'not_found');
    expectError(await file(leader, project.id, 'missing.txt'), 404, 'not_found');
    expectError(await file(leader, project.id, 'src/missing.ts'), 404, 'not_found');
    expectError(await file(leader, project.id, 'src'), 404, 'not_found');
    expectError(await file(leader, project.id, ''), 404, 'not_found');
    expectError(await tree(leader, project.id, 'README.md'), 404, 'not_found');
    expectError(await tree(leader, project.id, 'src/index.ts'), 404, 'not_found');

    const src = await tree(leader, project.id, 'src');
    expect(TreeResponseSchema.parse(src.body)).toEqual({
      path: 'src',
      entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 11 }],
    });
    expect(FileResponseSchema.parse((await file(leader, project.id, 'src/index.ts')).body)).toEqual(
      { path: 'src/index.ts', size: 11, isBinary: false, tooLarge: false, content: 'export {};\n' },
    );
  });

  it('sorts folders first, then names case-insensitively', async () => {
    const { leader, project } = await newProject();
    await setUpEmpty(leader, project.id);
    await commitFiles(await repoPathOf(project.id), {
      'b.txt': 'b',
      'A.txt': 'a',
      'c.md': 'c',
      'zeta/one.txt': '1',
      'Alpha/two.txt': '2',
      'beta/Gamma/deep.txt': 'deep',
      'beta/gamma.txt': 'g',
      'beta/Delta/x.txt': 'x',
    });
    const root = TreeResponseSchema.parse((await tree(leader, project.id, '')).body);
    expect(root.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:Alpha',
      'dir:beta',
      'dir:zeta',
      'file:A.txt',
      'file:b.txt',
      'file:c.md',
    ]);
    expect(root.entries.find((e) => e.name === 'Alpha')).toEqual({
      name: 'Alpha',
      path: 'Alpha',
      type: 'dir',
      size: null,
    });
    const beta = TreeResponseSchema.parse((await tree(leader, project.id, 'beta')).body);
    expect(beta.entries.map((e) => e.path)).toEqual(['beta/Delta', 'beta/Gamma', 'beta/gamma.txt']);
    const deep = TreeResponseSchema.parse((await tree(leader, project.id, 'beta/Gamma')).body);
    expect(deep.entries).toEqual([
      { name: 'deep.txt', path: 'beta/Gamma/deep.txt', type: 'file', size: 4 },
    ]);
  });

  it('flags binary and too-large files without sending their content', async () => {
    const { leader, project } = await newProject();
    await setUpEmpty(leader, project.id);
    const big = 'a'.repeat(MAX_FILE_VIEW_BYTES + 1);
    const exactlyMax = 'b'.repeat(MAX_FILE_VIEW_BYTES);
    await commitFiles(await repoPathOf(project.id), {
      'nul.bin': Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
      'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      'big.txt': big,
      'max.txt': exactlyMax,
      'unicode.txt': 'héllo wörld ✓\n',
    });

    const nul = FileResponseSchema.parse((await file(leader, project.id, 'nul.bin')).body);
    expect(nul).toEqual({
      path: 'nul.bin',
      size: 6,
      isBinary: true,
      tooLarge: false,
      content: null,
    });
    const latin1 = FileResponseSchema.parse((await file(leader, project.id, 'latin1.txt')).body);
    expect(latin1).toMatchObject({ isBinary: true, content: null, size: 5 });
    const tooBig = FileResponseSchema.parse((await file(leader, project.id, 'big.txt')).body);
    expect(tooBig).toEqual({
      path: 'big.txt',
      size: MAX_FILE_VIEW_BYTES + 1,
      isBinary: false,
      tooLarge: true,
      content: null,
    });
    const max = FileResponseSchema.parse((await file(leader, project.id, 'max.txt')).body);
    expect(max.tooLarge).toBe(false);
    expect(max.content).toBe(exactlyMax);
    const unicode = FileResponseSchema.parse((await file(leader, project.id, 'unicode.txt')).body);
    expect(unicode.content).toBe('héllo wörld ✓\n');

    const root = TreeResponseSchema.parse((await tree(leader, project.id)).body);
    expect(root.entries.find((e) => e.name === 'big.txt')?.size).toBe(MAX_FILE_VIEW_BYTES + 1);
  });
});

describe('import validation (no network)', () => {
  it('rejects disallowed hosts, http, credentials and non-repository links', async () => {
    const { leader, project } = await newProject();
    for (const url of [
      'https://example.com/owner/repo',
      'http://github.com/octocat/Hello-World',
      'https://user:secret@github.com/octocat/Hello-World',
      'https://token@github.com/octocat/Hello-World',
      'https://github.com:8443/octocat/Hello-World',
      'https://github.com/octocat',
      'file:///etc/passwd',
      'ext::sh -c touch% /tmp/pwned',
      'git@github.com:octocat/Hello-World.git',
    ]) {
      const res = await as(leader).post(`/api/projects/${project.id}/repository`, {
        source: 'import',
        url,
      });
      expectError(res, 400, 'validation_error');
      expect(res.body.fields?.url?.length, url).toBeGreaterThan(0);
    }
    expect((await status(leader, project.id)).status).toBe('none');
  });
});

describe('git hardening', () => {
  it('refuses non-https transports', async () => {
    const gitDir = join(env.REPOS_DIR, 'hardening.git');
    await runGit(['init', '--quiet', '--bare', '--', gitDir]);
    for (const url of [`file://${gitDir.replace(/\\/g, '/')}`, 'ext::git --version']) {
      const err = await runGit(['ls-remote', '--', url], { gitDir, timeoutMs: 10_000 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).kind).toBe('failed');
    }
  });

  it('kills git that runs past its timeout instead of hanging', async () => {
    const gitDir = join(env.REPOS_DIR, 'timeout.git');
    await runGit(['init', '--quiet', '--bare', '--', gitDir]);
    const started = Date.now();
    // A non-routable address: the connection never completes, so only the timeout ends it.
    const err = await runGit(['ls-remote', '--', 'https://10.255.255.1/owner/repo'], {
      gitDir,
      timeoutMs: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(['timeout', 'failed']).toContain((err as GitError).kind);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
});

describe('startup recovery and deletion', () => {
  it('marks imports interrupted by a restart as failed and removes their temp folder', async () => {
    const { leader, project } = await newProject();
    await prisma.project.update({
      where: { id: project.id },
      data: {
        repoStatus: 'importing',
        repoSource: 'import',
        importUrl: 'https://github.com/octocat/Hello-World',
      },
    });
    const temp = importTempDir(project.id);
    mkdirSync(join(temp, 'objects'), { recursive: true });
    writeFileSync(join(temp, 'objects', 'partial'), 'x');

    expect(await recoverInterruptedImports([project.id])).toBe(1);
    const after = await status(leader, project.id);
    expect(after).toMatchObject({ status: 'failed', error: INTERRUPTED_MESSAGE, lastCommit: null });
    expect(existsSync(temp)).toBe(false);

    // A failed repository can be set up again.
    expect((await setUpEmpty(leader, project.id)).status).toBe('ready');
  });

  it('deleting a project deletes its repository folder', async () => {
    const { leader, project } = await newProject('Doomed');
    await setUpEmpty(leader, project.id);
    const gitDir = repoDir(project.id);
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true);
    const res = await as(leader).delete(`/api/projects/${project.id}`, { confirmName: 'Doomed' });
    expect(res.status).toBe(204);
    expect(existsSync(gitDir)).toBe(false);
  });
});

// These two talk to github.com (CI has internet access).
describe('import from GitHub (network)', () => {
  it('imports octocat/Hello-World: default branch becomes main, with history', async () => {
    const { leader, project } = await newProject();
    const url = 'https://github.com/octocat/Hello-World';
    const res = await as(leader).post(`/api/projects/${project.id}/repository`, {
      source: 'import',
      url: `${url}.git`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const started = RepositoryResponseSchema.parse(res.body).repository;
    expect(started).toMatchObject({ source: 'import', importUrl: url });
    expect(['importing', 'ready']).toContain(started.status);

    const done = await waitWhileImporting(leader, project.id);
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'ready', error: null });
    expect(done.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/);

    const gitDir = await repoPathOf(project.id);
    const refs = await runGit(['for-each-ref', '--format=%(refname)'], { gitDir });
    expect(refs.stdout.toString().trim()).toBe(MAIN_REF);
    const count = await runGit(['rev-list', '--count', MAIN_REF, '--'], { gitDir });
    expect(Number(count.stdout.toString().trim())).toBeGreaterThan(1);
    const config = await runGit(['config', '--local', '--list'], { gitDir });
    expect(config.stdout.toString()).not.toContain('remote.');
    expect(existsSync(importTempDir(project.id))).toBe(false);

    const root = TreeResponseSchema.parse((await tree(leader, project.id)).body);
    expect(root.entries.map((e) => e.name)).toContain('README');
    const readme = FileResponseSchema.parse((await file(leader, project.id, 'README')).body);
    expect(readme.content).toContain('Hello World');

    const activity = await as(leader).get(`/api/projects/${project.id}/activity`);
    const entries = ActivityListResponseSchema.parse(activity.body).entries;
    expect(entries.find((e) => e.action === 'repository.imported')?.data).toEqual({ url });
  }, 90_000);

  it('a repository that does not exist fails with a plain message and can be retried', async () => {
    const { leader, project } = await newProject();
    const url = 'https://github.com/octocat/this-repo-does-not-exist-devspace';
    const res = await as(leader).post(`/api/projects/${project.id}/repository`, {
      source: 'import',
      url,
    });
    expect(res.status).toBe(202);
    const done = await waitWhileImporting(leader, project.id);
    expect(done).toMatchObject({
      status: 'failed',
      source: 'import',
      importUrl: url,
      error: "The repository wasn't found or isn't public",
      lastCommit: null,
    });
    expect(existsSync(importTempDir(project.id))).toBe(false);
    expect(existsSync(repoDir(project.id))).toBe(false);

    const activity = await as(leader).get(`/api/projects/${project.id}/activity`);
    const entries = ActivityListResponseSchema.parse(activity.body).entries;
    expect(entries.find((e) => e.action === 'repository.import_failed')?.data).toEqual({
      url,
      error: "The repository wasn't found or isn't public",
    });

    expect((await setUpEmpty(leader, project.id)).status).toBe('ready');
  }, 90_000);
});
