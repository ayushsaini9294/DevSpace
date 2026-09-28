import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CopyViewSchema, type CopyView } from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import { env } from '../config/env.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { cleanIdentity, lastCommit, MAIN_REF, type Identity } from '../git/repo.ts';
import { runGit } from '../git/run.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { projectNotFound } from '../projects/access.ts';
import { moveIntoPlace, removeDir } from '../repository/storage.ts';

/**
 * Working copies: each member has exactly one per project, a real git clone of the project's
 * bare repository on their own branch. Folders are computed from ids and never sent to clients.
 */

/** All of a project's copies: `<COPIES_DIR>/<projectId>`. */
export function projectCopiesDir(projectId: string): string {
  return join(env.COPIES_DIR, projectId);
}

/** One copy's folder: `<COPIES_DIR>/<projectId>/<copyId>`. */
export function copyDir(projectId: string, copyId: string): string {
  return join(projectCopiesDir(projectId), copyId);
}

/** The branch a member's work lives on in their copy. */
export function copyBranch(userId: string): string {
  return `copy/${userId}`;
}

const CLONE_TIMEOUT_MS = 5 * 60_000;

const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");

export const copySelect = {
  id: true,
  branchName: true,
  containerStatus: true,
  createdAt: true,
  lastActiveAt: true,
} as const;

/** The browser's view of a copy row: no paths, no container id, no token, no IDE link. */
export function toView(row: {
  id: string;
  branchName: string;
  containerStatus: string;
  createdAt: Date;
  lastActiveAt: Date | null;
}): CopyView {
  return CopyViewSchema.parse({
    id: row.id,
    branchName: row.branchName,
    containerStatus: row.containerStatus,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  });
}

/** The member's copy of the project, or null if they don't have one yet. */
export async function findCopy(projectId: string, userId: string): Promise<CopyView | null> {
  const row = await prisma.copy.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: copySelect,
  });
  return row && toView(row);
}

/**
 * Clones the bare repository at `repoPath` (a path we built) into `dir`, on a new branch
 * `branch` from main, with the member's identity for later commits. `--no-hardlinks` copies
 * every object file, so nothing in the copy is shared with the project's repository. The
 * `origin` remote and the local `main` are removed: the copy never points at a server path,
 * and its only branch is the member's own.
 */
async function cloneCopy(
  repoPath: string,
  dir: string,
  branch: string,
  identity: Identity,
): Promise<string> {
  await runGit(
    ['clone', '--quiet', '--no-hardlinks', '--template=', '--branch', 'main', '--', repoPath, dir],
    { allowLocalRepo: true, timeoutMs: CLONE_TIMEOUT_MS },
  );
  const inCopy = { cwd: dir };
  await runGit(['checkout', '--quiet', '-b', branch], inCopy);
  await runGit(['branch', '--quiet', '-D', 'main'], inCopy);
  await runGit(['remote', 'remove', 'origin'], inCopy);
  const who = cleanIdentity(identity);
  await runGit(['config', '--local', '--', 'user.name', who.name], inCopy);
  await runGit(['config', '--local', '--', 'user.email', who.email], inCopy);
  // The main commit the copy starts from. Read now, while the folder is still ours (it isn't
  // the member's until it is moved into place); never from a copy folder after that.
  const head = (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], inCopy)).stdout
    .toString('utf8')
    .trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new Error('unexpected clone head');
  return head;
}

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

/**
 * Returns the member's copy, making it first if they have none. The clone is built in a
 * temporary folder and moved into place inside the transaction that records it, so a
 * half-made copy is never used. If two first-opens race, the unique (project, user) row
 * decides: the loser deletes its folder and returns the winner's copy.
 */
export async function ensureCopy(
  projectId: string,
  user: Identity & { id: string },
): Promise<{ copy: CopyView; created: boolean }> {
  const existing = await findCopy(projectId, user.id);
  if (existing) return { copy: existing, created: false };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repoStatus: true, repoPath: true },
  });
  if (!project) throw projectNotFound();
  if (project.repoStatus !== 'ready' || !project.repoPath) throw notReady();

  const id = randomUUID();
  const branchName = copyBranch(user.id);
  const target = copyDir(projectId, id);
  const temp = `${target}.new`;
  await mkdir(projectCopiesDir(projectId), { recursive: true });
  try {
    const baseSha = await cloneCopy(project.repoPath, temp, branchName, user);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.copy.create({
        data: { id, projectId, userId: user.id, branchName, baseSha },
        select: copySelect,
      });
      await recordActivity(tx, {
        projectId,
        actorId: user.id,
        action: 'copy.created',
        target: user.id,
        data: { branchName },
      });
      await moveIntoPlace(temp, target);
      return created;
    });
    return { copy: toView(row), created: true };
  } catch (err) {
    // No row points at this attempt's folder (the transaction failed), so it can go.
    await removeDir(target).catch(() => undefined);
    if (isPrismaError(err, 'P2002')) {
      const winner = await findCopy(projectId, user.id);
      if (winner) return { copy: winner, created: false };
    }
    // The project (or the user) was deleted meanwhile.
    if (isPrismaError(err, 'P2003')) throw projectNotFound();
    throw err;
  } finally {
    await removeDir(temp).catch(() => undefined);
  }
}

/**
 * After a project is deleted: delete all its copies' folders. Failures are logged, never
 * thrown (the project is already gone).
 */
export async function removeProjectCopies(projectId: string): Promise<void> {
  try {
    await removeDir(projectCopiesDir(projectId));
  } catch (err) {
    console.error(
      `Could not remove the copies folder of deleted project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The main commit a copy was made from. Copies made before Phase 6 have none stored: they get
 * the project's current main, which is exact because nothing had merged before Phase 7.
 */
export async function copyBaseSha(
  copy: { id: string; baseSha: string | null },
  repoPath: string,
): Promise<string> {
  if (copy.baseSha) return copy.baseSha;
  const main = await lastCommit(repoPath, MAIN_REF);
  if (!main) throw notReady();
  await prisma.copy.updateMany({
    where: { id: copy.id, baseSha: null },
    data: { baseSha: main.sha },
  });
  const row = await prisma.copy.findUniqueOrThrow({
    where: { id: copy.id },
    select: { baseSha: true },
  });
  return row.baseSha ?? main.sha;
}

/** At startup: gives every copy made before Phase 6 its base commit. Returns how many. */
export async function backfillCopyBaseShas(): Promise<number> {
  const rows = await prisma.copy.findMany({
    where: { baseSha: null, project: { repoStatus: 'ready', repoPath: { not: null } } },
    select: { id: true, baseSha: true, project: { select: { repoPath: true } } },
  });
  let count = 0;
  for (const row of rows) {
    await copyBaseSha(row, row.project.repoPath!);
    count++;
  }
  return count;
}
