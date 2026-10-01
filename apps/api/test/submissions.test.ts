import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ActivityListResponseSchema,
  CommentResponseSchema,
  CopyChangesResponseSchema,
  ErrorResponseSchema,
  SubmissionFileResponseSchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  type SubmissionDetail,
} from '@devspace/shared';
import { copyDir } from '../src/copies/service.ts';
import { lastCommit, MAIN_REF, refExists } from '../src/git/repo.ts';
import { runGit } from '../src/git/run.ts';
import { prisma } from '../src/lib/prisma.ts';
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

// Each test sets up a project, a repository and copies with real git: allow for a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const BASE_FILES = {
  'README.md': '# Project\n',
  'src/a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  'src/b.ts': 'export const b = 2;\n',
  'docs/c.md': 'Docs\n',
  'build/keep.txt': 'tracked but under an ignored folder\n',
};

interface World {
  projectId: string;
  gitDir: string;
  base: string;
  leader: TestUser;
  ann: TestUser; // member, the usual author
  rev: TestUser; // member with Comment and Approve
  bob: TestUser; // member with no extra permissions
  annCopy: string; // folder of Ann's copy
}

async function setPermissions(leader: TestUser, projectId: string, user: TestUser, perms: object) {
  const res = await as(leader).patch(`/api/projects/${projectId}/members/${user.id}`, {
    permissions: perms,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function openCopy(user: TestUser, projectId: string): Promise<string> {
  const res = await as(user).post(`/api/projects/${projectId}/copy`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return copyDir(projectId, res.body.copy.id);
}

async function world(files: Record<string, string | Buffer> = BASE_FILES): Promise<World> {
  const leader = await signUp('Lena Leader');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, 'Review Project');
  const setup = await as(leader).post(`/api/projects/${project.id}/repository`, {
    source: 'empty',
  });
  expect(setup.status).toBe(202);
  const gitDir = (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).repoPath!;
  const base = await commitFiles(gitDir, files);
  const ann = await signUp('Ann Author');
  const rev = await signUp('Rex Reviewer');
  const bob = await signUp('Bob Bystander');
  for (const user of [ann, rev, bob]) await addMember(leader, project.id, user);
  await setPermissions(leader, project.id, rev, { comment: true, approve: true });
  const annCopy = await openCopy(ann, project.id);
  return { projectId: project.id, gitDir, base, leader, ann, rev, bob, annCopy };
}

function write(root: string, path: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const url = (w: World, rest = '') => `/api/projects/${w.projectId}${rest}`;

async function changes(w: World, user = w.ann) {
  const res = await as(user).get(url(w, '/copy/changes'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyChangesResponseSchema.parse(res.body);
}

async function submit(
  w: World,
  paths: string[],
  title = 'My work',
  user = w.ann,
): Promise<SubmissionDetail> {
  const res = await as(user).post(url(w, '/submissions'), { title, description: 'Why', paths });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SubmissionResponseSchema.parse(res.body).submission;
}

async function detail(w: World, id: string, user = w.ann): Promise<SubmissionDetail> {
  const res = await as(user).get(url(w, `/submissions/${id}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SubmissionResponseSchema.parse(res.body).submission;
}

async function show(gitDir: string, rev: string): Promise<string> {
  return (await runGit(['cat-file', '-p', rev], { gitDir })).stdout.toString('utf8');
}

async function lsTree(gitDir: string, rev: string, path: string): Promise<string> {
  return (await runGit(['ls-tree', rev, '--', path], { gitDir })).stdout.toString('utf8').trim();
}

async function review(w: World, id: string, user: TestUser, decision: string) {
  return as(user).post(url(w, `/submissions/${id}/reviews`), { decision });
}

describe('changed files', () => {
  it('lists added, modified and deleted files against the copy base, honouring .gitignore', async () => {
    const w = await world();
    const copy = await prisma.copy.findFirstOrThrow({ where: { userId: w.ann.id } });
    expect(copy.baseSha).toBe(w.base);

    write(w.annCopy, 'src/a.ts', 'changed\n');
    write(w.annCopy, 'new.ts', 'new\n');
    rmSync(join(w.annCopy, 'docs/c.md'));
    chmodSync(join(w.annCopy, 'src/b.ts'), 0o755); // mode change only
    write(w.annCopy, '.gitignore', 'build/\n*.log\n');
    write(w.annCopy, 'debug.log', 'ignored\n');
    write(w.annCopy, 'build/out.js', 'ignored: untracked under an ignored folder\n');
    write(w.annCopy, 'build/keep.txt', 'tracked files are never ignored\n');
    write(w.annCopy, 'lib/.gitignore', '!keep.log\nsecret.txt\n');
    write(w.annCopy, 'lib/keep.log', 'un-ignored by the nested file\n');
    write(w.annCopy, 'lib/secret.txt', 'ignored by the nested file\n');
    write(w.annCopy, 'node_modules/x/index.js', 'x');
    write(w.annCopy, '.gitignore', 'build/\n*.log\nnode_modules/\n');

    const result = await changes(w);
    expect(result.baseSha).toBe(w.base);
    expect(result.files).toEqual([
      { path: '.gitignore', change: 'added', openSubmissionId: null },
      { path: 'build/keep.txt', change: 'modified', openSubmissionId: null },
      { path: 'docs/c.md', change: 'deleted', openSubmissionId: null },
      { path: 'lib/.gitignore', change: 'added', openSubmissionId: null },
      { path: 'lib/keep.log', change: 'added', openSubmissionId: null },
      { path: 'new.ts', change: 'added', openSubmissionId: null },
      { path: 'src/a.ts', change: 'modified', openSubmissionId: null },
      { path: 'src/b.ts', change: 'modified', openSubmissionId: null },
    ]);
  });

  it('is empty for an untouched copy; 409 no_copy without a copy; 404 for non-members', async () => {
    const w = await world();
    expect((await changes(w)).files).toEqual([]);
    expectError(await as(w.bob).get(url(w, '/copy/changes')), 409, 'no_copy');
    const stranger = await signUp('Stranger');
    expectError(await as(stranger).get(url(w, '/copy/changes')), 404, 'not_found');
  });

  it('fills in the base commit of a copy made before Phase 6', async () => {
    const w = await world();
    await prisma.copy.updateMany({ where: { userId: w.ann.id }, data: { baseSha: null } });
    expect((await changes(w)).baseSha).toBe(w.base);
    const copy = await prisma.copy.findFirstOrThrow({ where: { userId: w.ann.id } });
    expect(copy.baseSha).toBe(w.base);
  });
});

describe('submitting', () => {
  it('snapshots only the chosen files in the bare repo; the copy and main are untouched', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'new a\n');
    write(w.annCopy, 'src/b.ts', 'new b\n');
    write(w.annCopy, 'added.ts', 'added\n');
    rmSync(join(w.annCopy, 'docs/c.md'));

    const sub = await submit(w, ['src/a.ts', 'added.ts', 'docs/c.md'], 'Two and a delete');
    expect(sub).toMatchObject({
      title: 'Two and a delete',
      description: 'Why',
      status: 'open',
      version: 1,
      author: { id: w.ann.id, name: 'Ann Author' },
      baseSha: w.base,
      fileCount: 3,
      approvals: 0,
      rejectReason: null,
    });
    expect(sub.files).toEqual([
      { path: 'added.ts', change: 'added' },
      { path: 'docs/c.md', change: 'deleted' },
      { path: 'src/a.ts', change: 'modified' },
    ]);
    expect(sub.viewerActions).toEqual(['update', 'comment', 'respondSuggestion', 'close']);

    const ref = `refs/submissions/${sub.id}/v1`;
    const head = (await runGit(['rev-parse', ref], { gitDir: w.gitDir })).stdout.toString().trim();
    expect(head).toBe(sub.headSha);
    expect(await show(w.gitDir, `${ref}:src/a.ts`)).toBe('new a\n');
    expect(await show(w.gitDir, `${ref}:added.ts`)).toBe('added\n');
    // Unticked file: as in base. Deleted file: gone. Others: untouched.
    expect(await show(w.gitDir, `${ref}:src/b.ts`)).toBe(BASE_FILES['src/b.ts']);
    expect(await lsTree(w.gitDir, ref, 'docs/c.md')).toBe('');
    expect(await show(w.gitDir, `${ref}:README.md`)).toBe(BASE_FILES['README.md']);
    // Parent = base, author = the member, message = title.
    const commit = await show(w.gitDir, ref);
    expect(commit).toContain(`parent ${w.base}\n`);
    expect(commit).toContain(`author Ann Author <${w.ann.id}@users.noreply.devspace.invalid>`);
    expect(commit.trimEnd().endsWith('Two and a delete')).toBe(true);
    // main unchanged; the copy's files unchanged.
    expect((await lastCommit(w.gitDir, MAIN_REF))!.sha).toBe(w.base);
    expect(readFileSync(join(w.annCopy, 'src/b.ts'), 'utf8')).toBe('new b\n');

    // The file is now locked to this submission.
    const now = await changes(w);
    expect(now.files.find((f) => f.path === 'src/a.ts')!.openSubmissionId).toBe(sub.id);
    expect(now.files.find((f) => f.path === 'src/b.ts')!.openSubmissionId).toBeNull();

    const log = ActivityListResponseSchema.parse(
      (await as(w.leader).get(url(w, '/activity'))).body,
    ).entries;
    expect(log.find((e) => e.action === 'submission.created')).toMatchObject({
      actorId: w.ann.id,
      target: sub.id,
    });
  });

  it('keeps the executable bit', async () => {
    const w = await world();
    write(w.annCopy, 'run.sh', '#!/bin/sh\n');
    chmodSync(join(w.annCopy, 'run.sh'), 0o755);
    const sub = await submit(w, ['run.sh']);
    expect(await lsTree(w.gitDir, sub.headSha, 'run.sh')).toMatch(/^100755 blob /);
  });

  it('refuses unchanged paths (409 no_changes) and a file already in an open submission', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'x\n');
    write(w.annCopy, 'src/b.ts', 'y\n');
    const res = await as(w.ann).post(url(w, '/submissions'), {
      title: 'T',
      paths: ['src/a.ts', 'README.md'],
    });
    expectError(res, 409, 'no_changes');
    expect(res.body.details).toEqual({ paths: ['README.md'] });

    const first = await submit(w, ['src/a.ts']);
    const clash = await as(w.ann).post(url(w, '/submissions'), {
      title: 'T2',
      paths: ['src/b.ts', 'src/a.ts'],
    });
    expectError(clash, 409, 'file_in_open_submission');
    expect(ErrorResponseSchema.parse(clash.body).details).toEqual({
      paths: ['src/a.ts'],
      submissionId: first.id,
    });
    // A different file is fine; once the first is closed its file is free again.
    await submit(w, ['src/b.ts'], 'Other');
    expect((await as(w.ann).post(url(w, `/submissions/${first.id}/close`))).status).toBe(200);
    await submit(w, ['src/a.ts'], 'Again');
  });

  it('validates the body and refuses files over 10 MB', async () => {
    const w = await world();
    expectError(
      await as(w.ann).post(url(w, '/submissions'), { title: '', paths: ['a'] }),
      400,
      'validation_error',
    );
    expectError(
      await as(w.ann).post(url(w, '/submissions'), { title: 'T', paths: ['../x'] }),
      400,
      'validation_error',
    );
    write(w.annCopy, 'big.bin', Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    const res = await as(w.ann).post(url(w, '/submissions'), { title: 'T', paths: ['big.bin'] });
    expectError(res, 409, 'submission_too_large');
    expect(res.body.details).toEqual({ paths: ['big.bin'] });
  });

  it('needs a copy (409 no_copy) and project membership (404)', async () => {
    const w = await world();
    expectError(
      await as(w.bob).post(url(w, '/submissions'), { title: 'T', paths: ['a'] }),
      409,
      'no_copy',
    );
    const stranger = await signUp('Stranger');
    expectError(
      await as(stranger).post(url(w, '/submissions'), { title: 'T', paths: ['a'] }),
      404,
      'not_found',
    );
  });
});

describe('copies are untrusted input', () => {
  it('submits a symlink to a file outside the copy as a link, never reading through it', async () => {
    const w = await world();
    const outside = mkdtempSync(join(tmpdir(), 'devspace-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
      mkdirSync(join(outside, 'dir'));
      writeFileSync(join(outside, 'dir', 'inner.txt'), 'ALSO SECRET\n');
      symlinkSync(join(outside, 'secret.txt'), join(w.annCopy, 'leak.txt'));
      symlinkSync(join(outside, 'dir'), join(w.annCopy, 'leakdir'));
      // A tracked file replaced by a link to a secret is a modification into a link.
      rmSync(join(w.annCopy, 'src/b.ts'));
      symlinkSync(join(outside, 'secret.txt'), join(w.annCopy, 'src/b.ts'));

      const found = await changes(w);
      expect(found.files.map((f) => f.path)).toEqual(['leak.txt', 'leakdir', 'src/b.ts']);
      const sub = await submit(w, ['leak.txt', 'leakdir', 'src/b.ts']);
      for (const path of ['leak.txt', 'leakdir', 'src/b.ts']) {
        expect(await lsTree(w.gitDir, sub.headSha, path)).toMatch(/^120000 blob /);
      }
      expect(await show(w.gitDir, `${sub.headSha}:leak.txt`)).toBe(join(outside, 'secret.txt'));
      expect(await show(w.gitDir, `${sub.headSha}:leakdir`)).toBe(join(outside, 'dir'));

      // The diff view shows the link text, never the target's contents.
      const file = await as(w.rev).get(url(w, `/submissions/${sub.id}/file?path=leak.txt`));
      expect(JSON.stringify(file.body)).not.toContain('SECRET');
      const all = JSON.stringify((await as(w.rev).get(url(w, `/submissions/${sub.id}`))).body);
      expect(all).not.toContain('SECRET');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a planted .git/config with filters, hooks and fsmonitor, and .gitattributes', async () => {
    const w = await world();
    const marker = join(tmpdir(), `devspace-pwned-${Date.now()}`);
    const evil = `touch ${marker}`;
    writeFileSync(
      join(w.annCopy, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = ${evil}`,
        `\thooksPath = hooks`,
        '[filter "evil"]',
        `\tclean = ${evil}`,
        `\tsmudge = ${evil}`,
        '\trequired = true',
        '',
      ].join('\n'),
    );
    mkdirSync(join(w.annCopy, '.git', 'hooks'), { recursive: true });
    for (const hook of [
      'pre-commit',
      'post-checkout',
      'reference-transaction',
      'post-index-change',
    ]) {
      writeFileSync(join(w.annCopy, '.git', 'hooks', hook), `#!/bin/sh\n${evil}\n`, {
        mode: 0o755,
      });
    }
    write(w.annCopy, '.gitattributes', '* filter=evil\n');
    write(w.annCopy, 'src/a.ts', 'raw bytes\n');
    write(w.annCopy, '.git/injected.ts', 'never listed\n');

    const found = await changes(w);
    expect(found.files.map((f) => f.path)).toEqual(['.gitattributes', 'src/a.ts']);
    const sub = await submit(w, ['src/a.ts', '.gitattributes']);
    expect(await show(w.gitDir, `${sub.headSha}:src/a.ts`)).toBe('raw bytes\n');
    await detail(w, sub.id, w.rev);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('reading submissions', () => {
  it('everyone in the project can list and read; strangers get 404', async () => {
    const w = await world();
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n',
    );
    write(w.annCopy, 'added.md', 'hello\n');
    write(w.annCopy, 'blob.bin', Buffer.from([0, 1, 2, 3]));
    write(w.annCopy, 'large.txt', 'x'.repeat(1024 * 1024 + 1));
    const sub = await submit(w, ['src/a.ts', 'added.md', 'blob.bin', 'large.txt']);

    const list = await as(w.bob).get(url(w, '/submissions'));
    expect(list.status).toBe(200);
    const summaries = SubmissionListResponseSchema.parse(list.body).submissions;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: sub.id, fileCount: 4, commentCount: 0 });

    const bobView = await detail(w, sub.id, w.bob);
    expect(bobView.viewerActions).toEqual([]);
    expect((await detail(w, sub.id, w.rev)).viewerActions).toEqual([
      'comment',
      'suggest',
      'approve',
      'requestChanges',
    ]);
    expect((await detail(w, sub.id, w.leader)).viewerActions).toEqual([
      'comment',
      'suggest',
      'approve',
      'requestChanges',
      'reject',
      'close',
    ]);

    const file = async (path: string) => {
      const res = await as(w.bob).get(
        url(w, `/submissions/${sub.id}/file?path=${encodeURIComponent(path)}`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return SubmissionFileResponseSchema.parse(res.body);
    };
    expect(await file('src/a.ts')).toEqual({
      path: 'src/a.ts',
      change: 'modified',
      base: { kind: 'text', content: BASE_FILES['src/a.ts'] },
      head: {
        kind: 'text',
        content: 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n',
      },
    });
    expect(await file('added.md')).toMatchObject({
      base: { kind: 'none' },
      head: { kind: 'text' },
    });
    expect((await file('blob.bin')).head).toEqual({ kind: 'binary' });
    expect((await file('large.txt')).head).toEqual({ kind: 'too_large' });
    expectError(
      await as(w.bob).get(url(w, `/submissions/${sub.id}/file?path=README.md`)),
      404,
      'not_found',
    );
    expectError(
      await as(w.bob).get(url(w, `/submissions/${sub.id}/file?path=../x`)),
      400,
      'validation_error',
    );

    const stranger = await signUp('Stranger');
    expectError(await as(stranger).get(url(w, '/submissions')), 404, 'not_found');
    expectError(await as(stranger).get(url(w, `/submissions/${sub.id}`)), 404, 'not_found');
    expectError(await as(w.bob).get(url(w, '/submissions/nope')), 404, 'not_found');
  });

  it('lists active by default and everything with status=all, newest first', async () => {
    const w = await world();
    write(w.annCopy, 'x.txt', 'x\n');
    write(w.annCopy, 'y.txt', 'y\n');
    const first = await submit(w, ['x.txt'], 'First');
    const second = await submit(w, ['y.txt'], 'Second');
    await as(w.ann).post(url(w, `/submissions/${first.id}/close`));
    const active = SubmissionListResponseSchema.parse(
      (await as(w.bob).get(url(w, '/submissions'))).body,
    ).submissions;
    expect(active.map((s) => s.id)).toEqual([second.id]);
    const all = SubmissionListResponseSchema.parse(
      (await as(w.bob).get(url(w, '/submissions?status=all'))).body,
    ).submissions;
    expect(all.map((s) => s.id)).toEqual([second.id, first.id]);
    expectError(await as(w.bob).get(url(w, '/submissions?status=nope')), 400, 'validation_error');
  });
});

describe('reviews and status', () => {
  it('nobody approves their own submission; approve needs the permission', async () => {
    const w = await world();
    // The leader authors: even a leader can't approve their own work.
    const leaderCopy = await openCopy(w.leader, w.projectId);
    write(leaderCopy, 'l.txt', 'l\n');
    const own = await submit(w, ['l.txt'], 'Lead work', w.leader);
    expect((await detail(w, own.id, w.leader)).viewerActions).not.toContain('approve');
    expectError(await review(w, own.id, w.leader, 'approved'), 403, 'own_submission');

    write(w.annCopy, 'a.txt', 'a\n');
    const sub = await submit(w, ['a.txt']);
    expectError(await review(w, sub.id, w.ann, 'approved'), 403, 'own_submission');
    expectError(await review(w, sub.id, w.bob, 'approved'), 403, 'forbidden');
    expect((await detail(w, sub.id)).status).toBe('open');
  });

  it('status comes from each reviewer’s latest current review; an update makes them stale', async () => {
    const w = await world();
    const rev2 = await signUp('Second Reviewer');
    await addMember(w.leader, w.projectId, rev2);
    await setPermissions(w.leader, w.projectId, rev2, { approve: true });
    write(w.annCopy, 'src/a.ts', 'one\n');
    const sub = await submit(w, ['src/a.ts']);

    let res = await review(w, sub.id, w.rev, 'approved');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(SubmissionResponseSchema.parse(res.body).submission).toMatchObject({
      status: 'approved',
      approvals: 1,
    });
    res = await review(w, sub.id, rev2, 'changes_requested');
    expect(res.body.submission.status).toBe('changes_requested');
    res = await review(w, sub.id, rev2, 'approved');
    expect(res.body.submission).toMatchObject({ status: 'approved', approvals: 2 });

    // Update: version 2, status open, earlier reviews stale, both snapshots kept.
    write(w.annCopy, 'src/a.ts', 'two\n');
    write(w.annCopy, 'more.txt', 'more\n');
    res = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), {
      title: 'Renamed',
      paths: ['src/a.ts', 'more.txt'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = SubmissionResponseSchema.parse(res.body).submission;
    expect(updated).toMatchObject({ status: 'open', version: 2, approvals: 0, title: 'Renamed' });
    expect(updated.reviews.every((r) => r.stale)).toBe(true);
    expect(updated.files.map((f) => f.path)).toEqual(['more.txt', 'src/a.ts']);
    expect(await show(w.gitDir, `refs/submissions/${sub.id}/v1:src/a.ts`)).toBe('one\n');
    expect(await show(w.gitDir, `refs/submissions/${sub.id}/v2:src/a.ts`)).toBe('two\n');
    expect(await refExists(w.gitDir, `refs/submissions/${sub.id}/v1`)).toBe(true);

    res = await review(w, sub.id, w.rev, 'changes_requested');
    expect(res.body.submission).toMatchObject({ status: 'changes_requested', approvals: 0 });

    // Only the author updates.
    expectError(
      await as(w.rev).post(url(w, `/submissions/${sub.id}/update`), {}),
      403,
      'forbidden',
    );
    // An update with no body re-reads the same files.
    write(w.annCopy, 'more.txt', 'more 2\n');
    res = await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), {});
    expect(res.body.submission).toMatchObject({ version: 3, status: 'open' });
    expect(await show(w.gitDir, `refs/submissions/${sub.id}/v3:more.txt`)).toBe('more 2\n');
  });

  it('reject needs a lead and a reason; close is for the author or a lead; then nothing is active', async () => {
    const w = await world();
    write(w.annCopy, 'a.txt', 'a\n');
    write(w.annCopy, 'b.txt', 'b\n');
    const sub = await submit(w, ['a.txt']);
    expectError(
      await as(w.rev).post(url(w, `/submissions/${sub.id}/reject`), { reason: 'no' }),
      403,
      'forbidden',
    );
    expectError(
      await as(w.leader).post(url(w, `/submissions/${sub.id}/reject`), { reason: ' ' }),
      400,
      'validation_error',
    );
    const res = await as(w.leader).post(url(w, `/submissions/${sub.id}/reject`), {
      reason: 'Out of scope',
    });
    expect(res.status).toBe(200);
    expect(res.body.submission).toMatchObject({ status: 'rejected', rejectReason: 'Out of scope' });
    expect(res.body.submission.closedAt).not.toBeNull();
    expect(res.body.submission.viewerActions).toEqual(['comment']);
    // The work stays in the copy.
    expect(readFileSync(join(w.annCopy, 'a.txt'), 'utf8')).toBe('a\n');

    for (const [path, body] of [
      ['/reject', { reason: 'again' }],
      ['/close', {}],
      ['/update', {}],
    ] as const) {
      const user = path === '/update' ? w.ann : w.leader;
      expectError(
        await as(user).post(url(w, `/submissions/${sub.id}${path}`), body),
        409,
        'submission_not_active',
      );
    }
    expectError(await review(w, sub.id, w.rev, 'approved'), 409, 'submission_not_active');

    const other = await submit(w, ['b.txt']);
    expectError(await as(w.bob).post(url(w, `/submissions/${other.id}/close`)), 403, 'forbidden');
    expectError(await as(w.rev).post(url(w, `/submissions/${other.id}/close`)), 403, 'forbidden');
    const closed = await as(w.leader).post(url(w, `/submissions/${other.id}/close`));
    expect(closed.body.submission.status).toBe('closed');

    const log = ActivityListResponseSchema.parse(
      (await as(w.leader).get(url(w, '/activity'))).body,
    ).entries.map((e) => e.action);
    expect(log).toEqual(expect.arrayContaining(['submission.rejected', 'submission.closed']));
  });
});

describe('comments', () => {
  it('reviewers and the author comment; others cannot; lines are checked', async () => {
    const w = await world();
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n',
    );
    const sub = await submit(w, ['src/a.ts']);
    const post = (user: TestUser, body: object) =>
      as(user).post(url(w, `/submissions/${sub.id}/comments`), body);

    expectError(await post(w.bob, { body: 'hi' }), 403, 'forbidden');
    const general = await post(w.ann, { body: 'Context for reviewers' });
    expect(general.status).toBe(201);
    const line = await post(w.rev, { body: 'Why 20?', path: 'src/a.ts', side: 'head', line: 2 });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    const lineComment = CommentResponseSchema.parse(line.body).comment;
    expect(lineComment).toMatchObject({
      path: 'src/a.ts',
      side: 'head',
      line: 2,
      startLine: 2,
      version: 1,
      outdated: false,
      suggestion: null,
    });
    const reply = await post(w.ann, { body: 'Spec says so', parentId: lineComment.id });
    expect(reply.body.comment.parentId).toBe(lineComment.id);
    const nested = await post(w.rev, { body: 'OK', parentId: reply.body.comment.id });
    expect(nested.body.comment.parentId).toBe(lineComment.id);

    expectError(
      await post(w.rev, { body: 'x', path: 'README.md', side: 'head', line: 1 }),
      400,
      'validation_error',
    );
    expectError(
      await post(w.rev, { body: 'x', path: 'src/a.ts', side: 'base', line: 99 }),
      400,
      'validation_error',
    );
    expectError(await post(w.rev, { body: 'x', parentId: 'missing' }), 404, 'not_found');
    // Suggestions need the Comment permission, even for the author.
    expectError(
      await post(w.ann, { body: 's', path: 'src/a.ts', side: 'head', line: 2, suggestion: 'x' }),
      403,
      'forbidden',
    );

    const view = await detail(w, sub.id, w.bob);
    expect(view.commentCount).toBe(4);
    expect(view.comments.map((c) => c.body)).toEqual([
      'Context for reviewers',
      'Why 20?',
      'Spec says so',
      'OK',
    ]);
  });

  it('marks a comment outdated when its line changes or its file leaves the submission', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', 'l1\nl2\nl3\n');
    write(w.annCopy, 'other.txt', 'o1\n');
    const sub = await submit(w, ['src/a.ts', 'other.txt']);
    const post = (body: object) => as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), body);
    await post({ body: 'on l1', path: 'src/a.ts', side: 'head', line: 1 });
    await post({ body: 'on l3', path: 'src/a.ts', side: 'head', line: 3 });
    await post({ body: 'on base', path: 'src/a.ts', side: 'base', line: 1 });
    await post({ body: 'on other', path: 'other.txt', side: 'head', line: 1 });

    write(w.annCopy, 'src/a.ts', 'l1\nl2\nCHANGED\n');
    await as(w.ann).post(url(w, `/submissions/${sub.id}/update`), { paths: ['src/a.ts'] });
    const view = await detail(w, sub.id);
    const outdated = Object.fromEntries(view.comments.map((c) => [c.body, c.outdated]));
    expect(outdated).toEqual({ 'on l1': false, 'on l3': true, 'on base': false, 'on other': true });
  });
});

describe('suggestions', () => {
  async function suggestionWorld() {
    const w = await world();
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n',
    );
    const sub = await submit(w, ['src/a.ts']);
    const res = await as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), {
      body: 'Use 2 and add d',
      path: 'src/a.ts',
      side: 'head',
      startLine: 2,
      line: 3,
      suggestion: 'export const b = 2;\nexport const c = 3;\nexport const d = 4;',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const comment = CommentResponseSchema.parse(res.body).comment;
    expect(comment.suggestionStatus).toBe('pending');
    expect((await review(w, sub.id, w.rev, 'approved')).body.submission.status).toBe('approved');
    const respond = (user: TestUser, decision: string, commentId = comment.id) =>
      as(user).post(url(w, `/submissions/${sub.id}/comments/${commentId}/suggestion`), {
        decision,
      });
    return { w, sub, comment, respond };
  }

  it('accept writes the lines into the copy and updates the submission (approvals reset)', async () => {
    const { w, sub, comment, respond } = await suggestionWorld();
    chmodSync(join(w.annCopy, 'src/a.ts'), 0o755);
    const modeBefore = statSync(join(w.annCopy, 'src/a.ts')).mode;
    expectError(await respond(w.rev, 'accept'), 403, 'forbidden');

    const res = await respond(w.ann, 'accept');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = SubmissionResponseSchema.parse(res.body).submission;
    const expected =
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n';
    expect(readFileSync(join(w.annCopy, 'src/a.ts'), 'utf8')).toBe(expected);
    expect(statSync(join(w.annCopy, 'src/a.ts')).mode).toBe(modeBefore);
    expect(updated).toMatchObject({ version: 2, status: 'open', approvals: 0 });
    expect(updated.comments.find((c) => c.id === comment.id)!.suggestionStatus).toBe('accepted');
    expect(await show(w.gitDir, `refs/submissions/${sub.id}/v2:src/a.ts`)).toBe(expected);

    expectError(await respond(w.ann, 'accept'), 409, 'suggestion_not_pending');
    const log = ActivityListResponseSchema.parse(
      (await as(w.leader).get(url(w, '/activity'))).body,
    ).entries.map((e) => e.action);
    expect(log).toEqual(
      expect.arrayContaining(['submission.suggestion_accepted', 'submission.updated']),
    );
  });

  it('accept refuses when those lines changed in the copy (409 suggestion_stale)', async () => {
    const { w, sub, respond } = await suggestionWorld();
    write(
      w.annCopy,
      'src/a.ts',
      'export const a = 1;\nexport const b = 99;\nexport const c = 3;\n',
    );
    expectError(await respond(w.ann, 'accept'), 409, 'suggestion_stale');
    expect(readFileSync(join(w.annCopy, 'src/a.ts'), 'utf8')).toContain('b = 99');
    expect((await detail(w, sub.id)).version).toBe(1);
  });

  it('accept never writes through a symlink', async () => {
    const { w, respond } = await suggestionWorld();
    const outside = mkdtempSync(join(tmpdir(), 'devspace-outside-'));
    try {
      const target = join(outside, 'victim.ts');
      writeFileSync(target, 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n');
      rmSync(join(w.annCopy, 'src/a.ts'));
      symlinkSync(target, join(w.annCopy, 'src/a.ts'));
      expectError(await respond(w.ann, 'accept'), 409, 'suggestion_stale');
      // Also through a linked folder.
      rmSync(join(w.annCopy, 'src'), { recursive: true });
      symlinkSync(outside, join(w.annCopy, 'src'));
      writeFileSync(join(outside, 'a.ts'), readFileSync(target));
      expectError(await respond(w.ann, 'accept'), 409, 'suggestion_stale');
      expect(readFileSync(target, 'utf8')).toContain('b = 20');
      expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toContain('b = 20');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reject marks it rejected and leaves the copy alone; only while active', async () => {
    const { w, sub, comment, respond } = await suggestionWorld();
    const res = await respond(w.ann, 'reject');
    expect(res.status).toBe(200);
    const view = SubmissionResponseSchema.parse(res.body).submission;
    expect(view.comments.find((c) => c.id === comment.id)!.suggestionStatus).toBe('rejected');
    expect(view.status).toBe('approved');
    expect(readFileSync(join(w.annCopy, 'src/a.ts'), 'utf8')).toContain('b = 20');

    await as(w.ann).post(url(w, `/submissions/${sub.id}/close`));
    expectError(await respond(w.ann, 'accept'), 409, 'submission_not_active');
    expectError(
      await as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), {
        body: 's',
        path: 'src/a.ts',
        side: 'head',
        line: 1,
        suggestion: 'x',
      }),
      409,
      'submission_not_active',
    );
  });

  it('refuses suggestions on the base side', async () => {
    const { w, sub } = await suggestionWorld();
    expectError(
      await as(w.rev).post(url(w, `/submissions/${sub.id}/comments`), {
        body: 's',
        path: 'src/a.ts',
        side: 'base',
        line: 1,
        suggestion: 'x',
      }),
      400,
      'validation_error',
    );
  });
});
