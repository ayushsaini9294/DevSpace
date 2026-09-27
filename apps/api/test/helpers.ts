import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { ErrorResponseSchema, SESSION_COOKIE_NAME } from '@devspace/shared';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import {
  lastCommit,
  MAIN_REF,
  updateRef,
  writeBlob,
  writeCommit,
  writeTree,
} from '../src/git/repo.ts';
import { waitForImports } from '../src/repository/import.ts';

export const app = createApp();

const createdUserIds: string[] = [];

export interface TestUser {
  id: string;
  name: string;
  email: string;
  cookie: string;
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const cookie = list.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error('no session cookie set');
  return cookie.split(';')[0]!;
}

export function uniqueEmail(prefix = 'p3'): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

export async function signUp(name = 'Tester', email = uniqueEmail()): Promise<TestUser> {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ name, email, password: 'a-good-password' });
  expect(res.status).toBe(201);
  createdUserIds.push(res.body.user.id);
  return { id: res.body.user.id, name, email: email.toLowerCase(), cookie: sessionCookie(res) };
}

/** Authenticated request helpers for one user. */
export function as(user: TestUser) {
  return {
    get: (url: string) => request(app).get(url).set('Cookie', user.cookie),
    post: (url: string, body: object = {}) =>
      request(app).post(url).set('Cookie', user.cookie).send(body),
    patch: (url: string, body: object) =>
      request(app).patch(url).set('Cookie', user.cookie).send(body),
    delete: (url: string, body?: object) => {
      const req = request(app).delete(url).set('Cookie', user.cookie);
      return body === undefined ? req : req.send(body);
    },
  };
}

/** Asserts status and a body matching ErrorResponseSchema with the given error code. */
export function expectError(res: request.Response, status: number, error: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ErrorResponseSchema.parse(res.body).error).toBe(error);
}

export async function createTeam(owner: TestUser, name = 'Team') {
  const res = await as(owner).post('/api/teams', { name });
  expect(res.status).toBe(201);
  return res.body.team as { id: string; name: string };
}

export async function createProject(leader: TestUser, teamId: string, name = 'Project') {
  const res = await as(leader).post(`/api/teams/${teamId}/projects`, { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.project as { id: string; name: string };
}

/** Invites `user` to the project (as `inviter`) and accepts; returns nothing on success. */
export async function addMember(inviter: TestUser, projectId: string, user: TestUser) {
  const invite = await as(inviter).post(`/api/projects/${projectId}/invitations`, {
    email: user.email,
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const accept = await as(user).post(
    `/api${invite.body.path}/accept`.replace('/invite/', '/invitations/'),
  );
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
}

/** Deletes everything the test users created (teams first: owner is ON DELETE RESTRICT). */
export async function cleanUp() {
  await waitForImports();
  await prisma.team.deleteMany({ where: { ownerId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
}

/**
 * Replaces main's files in a bare repository with `files` (paths → contents) as one new
 * commit, built with plumbing via the API's own git module. Nested paths become folders.
 */
export async function commitFiles(
  gitDir: string,
  files: Record<string, string | Buffer>,
  message = 'Test files\n',
) {
  interface Folder {
    files: Map<string, string | Buffer>;
    folders: Map<string, Folder>;
  }
  const root: Folder = { files: new Map(), folders: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = { files: new Map(), folders: new Map() }));
      folder = next;
    }
    folder.files.set(name, content);
  }
  const build = async (folder: Folder): Promise<string> => {
    const entries = [];
    for (const [name, content] of folder.files) {
      entries.push({
        mode: '100644' as const,
        type: 'blob' as const,
        sha: await writeBlob(gitDir, content),
        name,
      });
    }
    for (const [name, child] of folder.folders) {
      entries.push({
        mode: '040000' as const,
        type: 'tree' as const,
        sha: await build(child),
        name,
      });
    }
    return writeTree(gitDir, entries);
  };
  const parent = await lastCommit(gitDir, MAIN_REF);
  const commit = await writeCommit(gitDir, await build(root), parent ? [parent.sha] : [], message, {
    name: 'Test Bot',
    email: 'bot@example.test',
  });
  await updateRef(gitDir, MAIN_REF, commit);
  return commit;
}
