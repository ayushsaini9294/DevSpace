import { GitError, runGit } from './run.ts';

/** Operations on one bare repository. Paths and refs from users only ever reach git via stdin. */

export const MAIN_REF = 'refs/heads/main';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function assertSha(value: string): string {
  if (!SHA.test(value)) throw new GitError('failed', 'git returned an unexpected object id', 0, '');
  return value;
}

export interface Identity {
  name: string;
  email: string;
}

/** git refuses or silently strips these in identities. */
function cleanIdentityPart(value: string): string {
  return value.replace(/[<>\0\r\n]/g, '').trim();
}

/** The identity as git will accept it (never an empty name). */
export function cleanIdentity(identity: Identity): Identity {
  const email = cleanIdentityPart(identity.email);
  const name = cleanIdentityPart(identity.name) || email.split('@')[0] || 'DevSpace user';
  return { name, email };
}

function identityEnv(
  identity: Identity,
  date?: Date,
  committer?: Identity,
): Record<string, string> {
  const { name, email } = cleanIdentity(identity);
  const by = committer ? cleanIdentity(committer) : { name, email };
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: by.name,
    GIT_COMMITTER_EMAIL: by.email,
  };
  if (date) {
    const stamp = `${Math.floor(date.getTime() / 1000)} +0000`;
    env.GIT_AUTHOR_DATE = stamp;
    env.GIT_COMMITTER_DATE = stamp;
  }
  return env;
}

/** `git init --bare` with `main` as the initial branch. */
export async function initBare(dir: string): Promise<void> {
  await runGit(['init', '--quiet', '--bare', '--template=', '--initial-branch=main', '--', dir]);
}

/** Stores `content` as a blob and returns its id. */
export async function writeBlob(gitDir: string, content: string | Buffer): Promise<string> {
  const { stdout } = await runGit(['hash-object', '-w', '--stdin', '--no-filters'], {
    gitDir,
    input: content,
  });
  return assertSha(stdout.toString('utf8').trim());
}

export interface NewTreeEntry {
  mode: '100644' | '100755' | '040000' | '120000';
  type: 'blob' | 'tree';
  sha: string;
  name: string;
}

/** Builds one tree object from entries (names must not contain `/`, NUL or newlines). */
export async function writeTree(gitDir: string, entries: readonly NewTreeEntry[]): Promise<string> {
  const input = entries
    .map((e) => {
      if (/[/\0\n]/.test(e.name) || e.name === '') throw new Error(`bad tree entry name`);
      return `${e.mode} ${e.type} ${assertSha(e.sha)}\t${e.name}\0`;
    })
    .join('');
  const { stdout } = await runGit(['mktree', '-z'], { gitDir, input });
  return assertSha(stdout.toString('utf8').trim());
}

/**
 * Creates a commit object for `tree` with the given parents, credited to `identity` (author,
 * and committer unless `committer` is given).
 */
export async function writeCommit(
  gitDir: string,
  tree: string,
  parents: readonly string[],
  message: string,
  identity: Identity,
  date?: Date,
  committer?: Identity,
): Promise<string> {
  const args = ['commit-tree', assertSha(tree)];
  for (const parent of parents) args.push('-p', assertSha(parent));
  const { stdout } = await runGit(args, {
    gitDir,
    input: message,
    env: identityEnv(identity, date, committer),
  });
  return assertSha(stdout.toString('utf8').trim());
}

/** Points `ref` (a constant such as MAIN_REF) at `sha`. */
export async function updateRef(gitDir: string, ref: string, sha: string): Promise<void> {
  await runGit(['update-ref', '--', ref, assertSha(sha)], { gitDir });
}

export interface ObjectInfo {
  sha: string;
  type: 'blob' | 'tree' | 'commit' | 'tag';
  size: number;
}

/**
 * Resolves `<rev>:<path>` style names via `cat-file --batch-check` on stdin, so nothing
 * user-supplied is ever an argument. Returns null when the object doesn't exist.
 */
export async function resolveObject(gitDir: string, name: string): Promise<ObjectInfo | null> {
  if (/[\0\r\n]/.test(name)) return null;
  const { stdout } = await runGit(['cat-file', '--batch-check'], { gitDir, input: `${name}\n` });
  const line = stdout.toString('utf8').trim();
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|tree|commit|tag) (\d+)$/.exec(line);
  if (!match) return null;
  return { sha: match[1]!, type: match[2] as ObjectInfo['type'], size: Number(match[3]) };
}

export interface RawTreeEntry {
  mode: string;
  type: string;
  sha: string;
  /** Null for anything that isn't a blob. */
  size: number | null;
  name: string;
}

/** Lists one tree object (`ls-tree -z --long <sha>`), parsing the NUL-separated output. */
export async function listTreeObject(gitDir: string, treeSha: string): Promise<RawTreeEntry[]> {
  const { stdout } = await runGit(['ls-tree', '-z', '--long', '--full-tree', assertSha(treeSha)], {
    gitDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries: RawTreeEntry[] = [];
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(0, start);
    if (end === -1) end = stdout.length;
    const record = stdout.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    // "<mode> SP <type> SP <sha> SP+ <size or ->" then TAB then the raw name.
    const meta = record.subarray(0, tab).toString('utf8').trim().split(/ +/);
    if (meta.length !== 4) continue;
    const [mode, type, sha, size] = meta as [string, string, string, string];
    entries.push({
      mode,
      type,
      sha,
      size: type === 'blob' && /^\d+$/.test(size) ? Number(size) : null,
      name: record.subarray(tab + 1).toString('utf8'),
    });
  }
  return entries;
}

/** Reads a blob's bytes (the caller checks its size first). */
export async function readBlob(gitDir: string, sha: string, maxBytes: number): Promise<Buffer> {
  const { stdout } = await runGit(['cat-file', 'blob', assertSha(sha)], {
    gitDir,
    maxBuffer: maxBytes,
  });
  return stdout;
}

/** Does `ref` (a constant) exist? */
export async function refExists(gitDir: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
      gitDir,
    });
    return true;
  } catch (err) {
    if (err instanceof GitError && err.kind === 'failed' && err.exitCode === 1) return false;
    throw err;
  }
}

export interface CommitInfo {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committedAt: Date;
}

/** The newest commit on `ref`, or null if the branch doesn't exist. */
export async function lastCommit(gitDir: string, ref: string): Promise<CommitInfo | null> {
  if (!(await refExists(gitDir, ref))) return null;
  const { stdout } = await runGit(
    ['log', '-1', '--no-show-signature', '--format=%H%x00%an%x00%ae%x00%cI%x00%s', ref, '--'],
    { gitDir },
  );
  const [sha, authorName, authorEmail, date, subject] = stdout
    .toString('utf8')
    .replace(/\n$/, '')
    .split('\0');
  if (!sha || date === undefined) return null;
  return {
    sha: assertSha(sha),
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    committedAt: new Date(date),
    subject: subject ?? '',
  };
}

export interface FlatTreeEntry {
  /** `100644`, `100755`, `120000` (symlink) or `160000` (submodule). */
  mode: string;
  sha: string;
  /** Null for submodules. */
  size: number | null;
  /** Full path from the tree's root. */
  path: string;
}

/** Every file in a commit's tree, recursively (`ls-tree -r -z --long --full-tree`). */
export async function listAllFiles(gitDir: string, commitSha: string): Promise<FlatTreeEntry[]> {
  const { stdout } = await runGit(
    ['ls-tree', '-r', '-z', '--long', '--full-tree', `${assertSha(commitSha)}^{tree}`],
    { gitDir, maxBuffer: 256 * 1024 * 1024 },
  );
  const entries: FlatTreeEntry[] = [];
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(0, start);
    if (end === -1) end = stdout.length;
    const record = stdout.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    const meta = record.subarray(0, tab).toString('utf8').trim().split(/ +/);
    if (meta.length !== 4) continue;
    const [mode, , sha, size] = meta as [string, string, string, string];
    entries.push({
      mode,
      sha,
      size: /^\d+$/.test(size) ? Number(size) : null,
      path: record.subarray(tab + 1).toString('utf8'),
    });
  }
  return entries;
}

export interface IndexChange {
  path: string;
  /** Null removes the path. */
  entry: { mode: '100644' | '100755' | '120000'; sha: string } | null;
}

const ZERO_SHA = '0'.repeat(40);

/**
 * Builds the tree of `baseSha` with `changes` applied, using a temporary index file in
 * `indexDir` (a DevSpace temp folder). Paths travel only on stdin. Returns the new tree's id.
 */
export async function treeWithChanges(
  gitDir: string,
  baseSha: string,
  changes: readonly IndexChange[],
  indexFile: string,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await runGit(['read-tree', `${assertSha(baseSha)}^{tree}`], { gitDir, env });
  const input = changes
    .map((c) => {
      if (/[\0\n]/.test(c.path) || c.path === '') throw new Error('bad path');
      return c.entry
        ? `${c.entry.mode} ${assertSha(c.entry.sha)}\t${c.path}\0`
        : `0 ${ZERO_SHA}\t${c.path}\0`;
    })
    .join('');
  if (input) {
    await runGit(['update-index', '--add', '--remove', '--replace', '-z', '--index-info'], {
      gitDir,
      env,
      input,
    });
  }
  const { stdout } = await runGit(['write-tree'], { gitDir, env });
  return assertSha(stdout.toString('utf8').trim());
}

/** Deletes `ref` (a ref we built) if it exists. */
export async function deleteRef(gitDir: string, ref: string): Promise<void> {
  await runGit(['update-ref', '-d', '--', ref], { gitDir });
}

// ---------- Merging (Phase 7) ----------

/** The commit `ref` (a constant, or a sha) points at, or null if it doesn't exist. */
export async function resolveCommit(gitDir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
      { gitDir },
    );
    return assertSha(stdout.toString('utf8').trim());
  } catch (err) {
    if (err instanceof GitError && err.kind === 'failed' && err.exitCode === 1) return null;
    throw err;
  }
}

/** The tree of a commit. */
export async function treeOf(gitDir: string, commit: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--verify', `${assertSha(commit)}^{tree}`], {
    gitDir,
  });
  return assertSha(stdout.toString('utf8').trim());
}

/** The first parent of a commit, or null for a root commit. */
export async function parentOf(gitDir: string, commit: string): Promise<string | null> {
  return resolveCommit(gitDir, `${assertSha(commit)}^1`);
}

/** Is `ancestor` reachable from `descendant` (or the same commit)? */
export async function isAncestor(
  gitDir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { exitCode } = await runGit(
    ['merge-base', '--is-ancestor', assertSha(ancestor), assertSha(descendant)],
    { gitDir, okExitCodes: [1] },
  );
  return exitCode === 0;
}

/**
 * Moves `ref` from `oldSha` to `newSha` only if it still points at `oldSha` (compare-and-swap);
 * git fails otherwise, and nothing changes.
 */
export async function casRef(
  gitDir: string,
  ref: string,
  newSha: string,
  oldSha: string,
): Promise<void> {
  await runGit(['update-ref', '--', ref, assertSha(newSha), assertSha(oldSha)], { gitDir });
}

export interface MergeResult {
  /** The merged tree; for conflicts it holds Git's conflict markers (or one side's version). */
  tree: string;
  /** Conflicted paths, sorted. Empty for a clean merge. */
  conflicts: string[];
}

/**
 * A three-way merge done entirely in the object store (`git merge-tree --write-tree`): nothing
 * is checked out and no ref moves. `ours` and `theirs` may be refs we built (their names become
 * the conflict marker labels) or shas; `base` is a commit.
 */
export async function mergeTree(
  gitDir: string,
  base: string,
  ours: string,
  theirs: string,
): Promise<MergeResult> {
  const { stdout, exitCode } = await runGit(
    [
      'merge-tree',
      '--write-tree',
      '-z',
      '--name-only',
      '--no-messages',
      `--merge-base=${assertSha(base)}`,
      '--end-of-options',
      ours,
      theirs,
    ],
    { gitDir, okExitCodes: [1], maxBuffer: 64 * 1024 * 1024 },
  );
  const parts = stdout.toString('utf8').split('\0');
  const tree = assertSha(parts[0] ?? '');
  const conflicts =
    exitCode === 1 ? [...new Set(parts.slice(1).filter((p) => p !== ''))].sort(byPath) : [];
  return { tree, conflicts };
}

/** Byte-order path comparison (what git uses). */
export function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Paths that differ between two commits or trees (no rename detection), sorted. */
export async function changedPaths(gitDir: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await runGit(
    ['diff-tree', '-r', '-z', '--name-only', '--no-renames', assertSha(from), assertSha(to)],
    { gitDir, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p !== '')
    .sort(byPath);
}
