import {
  FileResponseSchema,
  MAX_FILE_VIEW_BYTES,
  RepositoryResponseSchema,
  TreeResponseSchema,
  type TreeEntry,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import {
  initBare,
  lastCommit,
  listTreeObject,
  MAIN_REF,
  readBlob,
  resolveObject,
  updateRef,
  writeBlob,
  writeCommit,
  writeTree,
  type Identity,
  type RawTreeEntry,
} from '../git/repo.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { cancelImport } from './import.ts';
import {
  ensureReposDir,
  importTempDir,
  moveIntoPlace,
  newTempDir,
  removeDir,
  repoDir,
} from './storage.ts';

export const repositoryExists = (message = 'This project already has a repository') =>
  new HttpError(409, 'repository_exists', message);

const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");

const repoSelect = {
  repoStatus: true,
  repoSource: true,
  importUrl: true,
  repoError: true,
  repoPath: true,
} as const;

/** GET /repository: the status, plus main's newest commit when ready. */
export async function repositoryResponse(projectId: string) {
  const row = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: repoSelect,
  });
  const commit =
    row.repoStatus === 'ready' && row.repoPath ? await lastCommit(row.repoPath, MAIN_REF) : null;
  return RepositoryResponseSchema.parse({
    repository: {
      status: row.repoStatus,
      source: row.repoSource,
      importUrl: row.importUrl,
      error: row.repoStatus === 'failed' ? row.repoError : null,
      lastCommit: commit && {
        sha: commit.sha,
        message: commit.subject,
        authorName: commit.authorName,
        committedAt: commit.committedAt.toISOString(),
      },
    },
  });
}

/** Status `none` or `failed` is the only state a repository can be set up from. */
async function assertCanSetUp(projectId: string): Promise<void> {
  const row = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { repoStatus: true },
  });
  if (row.repoStatus === 'importing') throw repositoryExists('An import is already running');
  if (row.repoStatus === 'ready') throw repositoryExists();
}

/**
 * Creates the bare repository with one commit on main adding README.md, credited to `user`.
 * Built in a temporary folder and moved into place inside the transaction that marks it ready.
 */
export async function setUpEmpty(
  project: { id: string; name: string },
  user: Identity & { id: string },
): Promise<void> {
  await assertCanSetUp(project.id);
  await ensureReposDir();
  const temp = newTempDir(project.id);
  const target = repoDir(project.id);
  try {
    await initBare(temp);
    const blob = await writeBlob(temp, `# ${project.name}\n`);
    const tree = await writeTree(temp, [
      { mode: '100644', type: 'blob', sha: blob, name: 'README.md' },
    ]);
    const commit = await writeCommit(temp, tree, [], 'Add README.md\n', user);
    await updateRef(temp, MAIN_REF, commit);

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({
        where: { id: project.id, repoStatus: { in: ['none', 'failed'] } },
        data: {
          repoStatus: 'ready',
          repoSource: 'empty',
          importUrl: null,
          repoError: null,
          repoPath: target,
        },
      });
      if (count !== 1) throw repositoryExists();
      await recordActivity(tx, {
        projectId: project.id,
        actorId: user.id,
        action: 'repository.created',
        data: { source: 'empty' },
      });
      await moveIntoPlace(temp, target);
    });
  } finally {
    await removeDir(temp).catch(() => undefined);
  }
}

/** Claims the project for an import (status → importing), or 409 if it can't be set up now. */
export async function claimImport(projectId: string, url: string): Promise<void> {
  const { count } = await prisma.project.updateMany({
    where: { id: projectId, repoStatus: { in: ['none', 'failed'] } },
    data: {
      repoStatus: 'importing',
      repoSource: 'import',
      importUrl: url,
      repoError: null,
      repoPath: null,
    },
  });
  if (count !== 1) {
    await assertCanSetUp(projectId);
    throw repositoryExists();
  }
}

/** The bare repository's path, or 409 `repository_not_ready`. */
async function readyRepoPath(projectId: string): Promise<string> {
  const row = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { repoStatus: true, repoPath: true },
  });
  if (row.repoStatus !== 'ready' || !row.repoPath) throw notReady();
  return row.repoPath;
}

function entryType(mode: string): TreeEntry['type'] {
  if (mode === '040000') return 'dir';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return 'file';
}

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Lists the folder `path` on main, or null if that isn't a folder there. */
async function listFolder(gitDir: string, path: string): Promise<RawTreeEntry[] | null> {
  const object = await resolveObject(gitDir, `${MAIN_REF}:${path}`);
  if (!object || object.type !== 'tree') return null;
  return listTreeObject(gitDir, object.sha);
}

const folderNotFound = () => new HttpError(404, 'not_found', 'Folder not found');
const fileNotFound = () => new HttpError(404, 'not_found', 'File not found');

export async function treeResponse(projectId: string, path: string) {
  const gitDir = await readyRepoPath(projectId);
  const raw = await listFolder(gitDir, path);
  if (!raw) throw folderNotFound();
  const entries: TreeEntry[] = raw.map((e) => {
    const type = entryType(e.mode);
    return {
      name: e.name,
      path: joinPath(path, e.name),
      type,
      size: type === 'file' ? e.size : null,
    };
  });
  entries.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return TreeResponseSchema.parse({ path, entries });
}

const BINARY_SNIFF_BYTES = 8000;

/** UTF-8 text, or null if the bytes look binary (a NUL early on, or invalid UTF-8). */
export function decodeText(bytes: Buffer): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function fileResponse(projectId: string, path: string) {
  const gitDir = await readyRepoPath(projectId);
  if (path === '') throw fileNotFound();
  const slash = path.lastIndexOf('/');
  const parent = slash === -1 ? '' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const entries = await listFolder(gitDir, parent);
  const entry = entries?.find((e) => e.name === name);
  if (!entry || entry.type !== 'blob' || entryType(entry.mode) !== 'file' || entry.size === null) {
    throw fileNotFound();
  }
  const size = entry.size;
  if (size > MAX_FILE_VIEW_BYTES) {
    return FileResponseSchema.parse({ path, size, isBinary: false, tooLarge: true, content: null });
  }
  const content = decodeText(await readBlob(gitDir, entry.sha, MAX_FILE_VIEW_BYTES));
  return FileResponseSchema.parse({
    path,
    size,
    isBinary: content === null,
    tooLarge: false,
    content,
  });
}

/**
 * After a project is deleted: stop its import and delete its repository folders. Failures are
 * logged, never thrown (the project is already gone).
 */
export async function removeProjectRepository(projectId: string, repoPath: string | null) {
  await cancelImport(projectId).catch(() => undefined);
  const folders = new Set([repoDir(projectId), importTempDir(projectId)]);
  if (repoPath) folders.add(repoPath);
  for (const folder of folders) {
    try {
      await removeDir(folder);
    } catch (err) {
      console.error(
        `Could not remove the repository folder of deleted project ${projectId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
