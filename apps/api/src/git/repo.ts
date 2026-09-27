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

function identityEnv(identity: Identity, date?: Date): Record<string, string> {
  const email = cleanIdentityPart(identity.email);
  const name = cleanIdentityPart(identity.name) || email.split('@')[0] || 'DevSpace user';
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
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
  const { stdout } = await runGit(['hash-object', '-w', '--stdin'], { gitDir, input: content });
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

/** Creates a commit object for `tree` with the given parents, credited to `identity`. */
export async function writeCommit(
  gitDir: string,
  tree: string,
  parents: readonly string[],
  message: string,
  identity: Identity,
  date?: Date,
): Promise<string> {
  const args = ['commit-tree', assertSha(tree)];
  for (const parent of parents) args.push('-p', assertSha(parent));
  const { stdout } = await runGit(args, {
    gitDir,
    input: message,
    env: identityEnv(identity, date),
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
