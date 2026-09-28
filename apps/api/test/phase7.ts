import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import {
  CopyChangesResponseSchema,
  CopyResponseSchema,
  SubmissionResponseSchema,
  type CopyView,
  type SubmissionDetail,
} from '@devspace/shared';
import { copyDir } from '../src/copies/service.ts';
import { MAIN_REF, resolveCommit } from '../src/git/repo.ts';
import { runGit } from '../src/git/run.ts';
import { prisma } from '../src/lib/prisma.ts';
import {
  addMember,
  as,
  commitFiles,
  createProject,
  createTeam,
  signUp,
  type TestUser,
} from './helpers.ts';

/** Shared set-up for the Phase 7 tests (merge, revert, copy updates, leader help). */

export const BASE_FILES = {
  'README.md': '# Project\n',
  'src/a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  'src/b.ts': 'export const b = 2;\n',
  'docs/c.md': 'Docs\n',
};

export interface World {
  projectId: string;
  gitDir: string;
  base: string;
  leader: TestUser;
  ann: TestUser; // member, the usual author
  rev: TestUser; // member with Comment and Approve
  bob: TestUser; // member, a second author
  annCopy: string;
  bobCopy: string;
  annCopyId: string;
  bobCopyId: string;
}

export async function setPermissions(
  leader: TestUser,
  projectId: string,
  user: TestUser,
  perms: object,
) {
  const res = await as(leader).patch(`/api/projects/${projectId}/members/${user.id}`, {
    permissions: perms,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

export async function setSettings(w: World, settings: object) {
  const res = await as(w.leader).patch(`/api/projects/${w.projectId}/settings`, settings);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function openCopy(user: TestUser, projectId: string) {
  const res = await as(user).post(`/api/projects/${projectId}/copy`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { dir: copyDir(projectId, res.body.copy.id), id: res.body.copy.id as string };
}

export async function world(files: Record<string, string> = BASE_FILES): Promise<World> {
  const leader = await signUp('Lena Leader');
  const team = await createTeam(leader);
  const project = await createProject(leader, team.id, 'Merge Project');
  const setup = await as(leader).post(`/api/projects/${project.id}/repository`, {
    source: 'empty',
  });
  expect(setup.status).toBe(202);
  const gitDir = (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).repoPath!;
  const base = await commitFiles(gitDir, files);
  const ann = await signUp('Ann Author');
  const rev = await signUp('Rex Reviewer');
  const bob = await signUp('Bob Builder');
  for (const user of [ann, rev, bob]) await addMember(leader, project.id, user);
  await setPermissions(leader, project.id, rev, { comment: true, approve: true });
  const annCopy = await openCopy(ann, project.id);
  const bobCopy = await openCopy(bob, project.id);
  return {
    projectId: project.id,
    gitDir,
    base,
    leader,
    ann,
    rev,
    bob,
    annCopy: annCopy.dir,
    bobCopy: bobCopy.dir,
    annCopyId: annCopy.id,
    bobCopyId: bobCopy.id,
  };
}

export function write(root: string, path: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

export const url = (w: World, rest = '') => `/api/projects/${w.projectId}${rest}`;

export async function submit(
  w: World,
  user: TestUser,
  paths: string[],
  title = 'My work',
  description = 'Why it matters',
): Promise<SubmissionDetail> {
  const res = await as(user).post(url(w, '/submissions'), { title, description, paths });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SubmissionResponseSchema.parse(res.body).submission;
}

export async function detail(w: World, id: string, user: TestUser): Promise<SubmissionDetail> {
  const res = await as(user).get(url(w, `/submissions/${id}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SubmissionResponseSchema.parse(res.body).submission;
}

export async function approve(w: World, id: string) {
  const res = await as(w.rev).post(url(w, `/submissions/${id}/reviews`), { decision: 'approved' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

export async function merge(w: World, id: string, user = w.leader) {
  return as(user).post(url(w, `/submissions/${id}/merge`));
}

export async function revert(w: World, id: string, user = w.leader) {
  return as(user).post(url(w, `/submissions/${id}/revert`));
}

export async function getCopy(w: World, user: TestUser): Promise<CopyView> {
  const res = await as(user).get(url(w, '/copy'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyResponseSchema.parse(res.body).copy!;
}

export async function changes(w: World, user: TestUser) {
  const res = await as(user).get(url(w, '/copy/changes'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyChangesResponseSchema.parse(res.body);
}

export async function git(gitDir: string, args: string[]): Promise<string> {
  return (await runGit(args, { gitDir })).stdout.toString('utf8');
}

/** A file's content in main (or at any commit). */
export async function showFile(gitDir: string, path: string, rev = 'main'): Promise<string> {
  return git(gitDir, ['cat-file', 'blob', `${rev}:${path}`]);
}

export async function mainSha(gitDir: string): Promise<string> {
  return (await resolveCommit(gitDir, MAIN_REF))!;
}
