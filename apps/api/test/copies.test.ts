import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ActivityListResponseSchema,
  CopyResponseSchema,
  RepositoryResponseSchema,
  type CopyView,
} from '@devspace/shared';
import { env } from '../src/config/env.ts';
import { copyDir, projectCopiesDir } from '../src/copies/service.ts';
import { lastCommit, MAIN_REF } from '../src/git/repo.ts';
import { runGit } from '../src/git/run.ts';
import { prisma } from '../src/lib/prisma.ts';
import {
  addMember,
  as,
  cleanUp,
  createProject,
  createTeam,
  expectError,
  signUp,
  type TestUser,
} from './helpers.ts';

afterAll(cleanUp);

async function newProject(name = 'Copy Project', { ready = true } = {}) {
  const leader = await signUp('Lena Leader');
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

async function repoPathOf(projectId: string): Promise<string> {
  const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  return row.repoPath!;
}

const copyUrl = (projectId: string) => `/api/projects/${projectId}/copy`;

async function openCopy(user: TestUser, projectId: string, status = 201): Promise<CopyView> {
  const res = await as(user).post(copyUrl(projectId));
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  // No server paths ever reach the client.
  expect(JSON.stringify(res.body)).not.toContain(env.COPIES_DIR);
  expect(JSON.stringify(res.body)).not.toContain(env.REPOS_DIR);
  const { copy } = CopyResponseSchema.parse(res.body);
  expect(copy).not.toBeNull();
  return copy!;
}

async function getCopy(user: TestUser, projectId: string): Promise<CopyView | null> {
  const res = await as(user).get(copyUrl(projectId));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyResponseSchema.parse(res.body).copy;
}

async function gitIn(dir: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd: dir })).stdout.toString('utf8').trim();
}

/** Every regular file under `dir`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('working copies', () => {
  it("a member's first open clones main onto their own branch, with their identity", async () => {
    const { leader, project } = await newProject('Moon Base');
    const copy = await openCopy(leader, project.id);
    expect(copy.branchName).toBe(`copy/${leader.id}`);
    expect(copy.containerStatus).toBe('none');
    expect(copy.lastActiveAt).toBeNull();

    const dir = copyDir(project.id, copy.id);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# Moon Base\n');
    expect(statSync(join(dir, '.git')).isDirectory()).toBe(true);

    // On its own branch, at main's commit, with no server path and no other branch.
    const main = await lastCommit(await repoPathOf(project.id), MAIN_REF);
    expect(await gitIn(dir, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/copy/${leader.id}`);
    expect(await gitIn(dir, ['rev-parse', 'HEAD'])).toBe(main!.sha);
    expect(await gitIn(dir, ['for-each-ref', '--format=%(refname)'])).toBe(
      `refs/heads/copy/${leader.id}`,
    );
    expect(await gitIn(dir, ['remote'])).toBe('');
    expect(await gitIn(dir, ['status', '--porcelain'])).toBe('');
    expect(await gitIn(dir, ['config', '--local', 'user.name'])).toBe('Lena Leader');
    expect(await gitIn(dir, ['config', '--local', 'user.email'])).toBe(leader.email);

    const activity = await as(leader).get(`/api/projects/${project.id}/activity`);
    const entries = ActivityListResponseSchema.parse(activity.body).entries;
    expect(entries.find((e) => e.action === 'copy.created')).toMatchObject({
      actorId: leader.id,
      data: { branchName: copy.branchName },
    });
  });

  it('GET is null before the first open and the copy after; opening again returns the same copy', async () => {
    const { leader, project } = await newProject();
    expect(await getCopy(leader, project.id)).toBeNull();
    expect(existsSync(projectCopiesDir(project.id))).toBe(false);

    const first = await openCopy(leader, project.id, 201);
    expect(await getCopy(leader, project.id)).toEqual(first);
    const again = await openCopy(leader, project.id, 200);
    expect(again).toEqual(first);
    expect(readdirSync(projectCopiesDir(project.id))).toEqual([first.id]);
  });

  it('two first-opens at the same time make exactly one copy and one folder', async () => {
    const { leader, project } = await newProject();
    const [a, b] = await Promise.all([
      as(leader).post(copyUrl(project.id)),
      as(leader).post(copyUrl(project.id)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const copyA = CopyResponseSchema.parse(a.body).copy!;
    const copyB = CopyResponseSchema.parse(b.body).copy!;
    expect(copyA.id).toBe(copyB.id);
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(1);
    // The loser's clone is gone: only the winner's folder is left.
    expect(readdirSync(projectCopiesDir(project.id))).toEqual([copyA.id]);
    expect(existsSync(join(copyDir(project.id, copyA.id), 'README.md'))).toBe(true);
  });

  it("shares no object files with the project's repository", async () => {
    const { leader, project } = await newProject();
    const copy = await openCopy(leader, project.id);
    const copyObjects = filesUnder(join(copyDir(project.id, copy.id), '.git', 'objects'));
    const repoObjects = filesUnder(join(await repoPathOf(project.id), 'objects'));
    expect(copyObjects.length).toBeGreaterThan(0);
    expect(repoObjects.length).toBeGreaterThan(0);
    const repoInodes = new Set(repoObjects.map((f) => statSync(f).ino));
    for (const file of copyObjects) {
      const info = statSync(file);
      expect(info.nlink, file).toBe(1);
      expect(repoInodes.has(info.ino), file).toBe(false);
    }
    for (const file of repoObjects) expect(statSync(file).nlink, file).toBe(1);
  });

  it('two members get two different copies, each on their own branch', async () => {
    const { leader, project } = await newProject();
    // A name starting with "-" must still be stored as the name, not read as an option.
    const member = await signUp('-Dash Member');
    await addMember(leader, project.id, member);

    const mine = await openCopy(leader, project.id);
    const theirs = await openCopy(member, project.id);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.branchName).toBe(`copy/${member.id}`);
    expect(await getCopy(member, project.id)).toEqual(theirs);
    expect(await getCopy(leader, project.id)).toEqual(mine);

    const leaderDir = copyDir(project.id, mine.id);
    const memberDir = copyDir(project.id, theirs.id);
    expect(readdirSync(projectCopiesDir(project.id)).sort()).toEqual([mine.id, theirs.id].sort());
    expect(await gitIn(memberDir, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/copy/${member.id}`);
    expect(await gitIn(memberDir, ['config', '--local', 'user.name'])).toBe('-Dash Member');
    expect(await gitIn(memberDir, ['config', '--local', 'user.email'])).toBe(member.email);
    expect(await gitIn(leaderDir, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/copy/${leader.id}`);
  });

  it('non-members get the same 404 as for any project route, and no copy is made', async () => {
    const { project } = await newProject();
    const outsider = await signUp('Olly Outsider');
    expectError(await as(outsider).post(copyUrl(project.id)), 404, 'not_found');
    expectError(await as(outsider).get(copyUrl(project.id)), 404, 'not_found');
    expectError(await as(outsider).get(`/api/projects/${project.id}`), 404, 'not_found');
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(0);
    expect(existsSync(projectCopiesDir(project.id))).toBe(false);
  });

  it("refuses with 409 while the project's repository isn't ready", async () => {
    const { leader, project } = await newProject('No Repo', { ready: false });
    expectError(await as(leader).post(copyUrl(project.id)), 409, 'repository_not_ready');
    expect(await getCopy(leader, project.id)).toBeNull();
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("deleting the project deletes all its copies' folders", async () => {
    const { leader, project } = await newProject('Doomed');
    const copy = await openCopy(leader, project.id);
    expect(existsSync(join(copyDir(project.id, copy.id), 'README.md'))).toBe(true);
    const res = await as(leader).delete(`/api/projects/${project.id}`, { confirmName: 'Doomed' });
    expect(res.status).toBe(204);
    expect(existsSync(projectCopiesDir(project.id))).toBe(false);
    expect(await prisma.copy.count({ where: { projectId: project.id } })).toBe(0);
  });
});
