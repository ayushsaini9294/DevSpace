import type { Identity } from '../git/repo.ts';
import { runGit } from '../git/run.ts';
import { MAIN_REF, resolveCommit } from '../git/repo.ts';
import { prisma } from '../lib/prisma.ts';
import type { Db } from '../projects/access.ts';

/**
 * Private commit emails (Phase 13, owner decision). Every commit DevSpace makes uses a private
 * address: the person's GitHub noreply address when they connected GitHub (so the commit links
 * to their profile), otherwise a DevSpace one that can never receive mail. Names stay as they
 * are.
 */

export const DEVSPACE_NOREPLY_DOMAIN = 'users.noreply.devspace.invalid';
export const GITHUB_NOREPLY_DOMAIN = 'users.noreply.github.com';

export function githubNoreply(githubUserId: bigint | number | string, login: string): string {
  return `${githubUserId}+${login}@${GITHUB_NOREPLY_DOMAIN}`;
}

export function devspaceNoreply(userId: string): string {
  return `${userId}@${DEVSPACE_NOREPLY_DOMAIN}`;
}

/** The identity for commits credited to `user` (name as shown in DevSpace, private email). */
export async function commitIdentity(
  user: { id: string; name: string },
  db: Db = prisma,
): Promise<Identity> {
  const account = await db.githubAccount.findUnique({
    where: { userId: user.id },
    select: { githubUserId: true, login: true },
  });
  return {
    name: user.name,
    email: account ? githubNoreply(account.githubUserId, account.login) : devspaceNoreply(user.id),
  };
}

/** True for an address that is private: a GitHub or DevSpace noreply one (or GitHub's own). */
export function isPrivateEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return (
    e === '' ||
    e.endsWith(`@${GITHUB_NOREPLY_DOMAIN}`) ||
    e.endsWith(`@${DEVSPACE_NOREPLY_DOMAIN}`) ||
    e === 'noreply@github.com'
  );
}

const warningCache = new Map<string, string[]>();

/**
 * The names of people whose real (not noreply) email address is in main's history, as author
 * or committer, sorted. Only names are returned, never the addresses. Cached per main commit.
 */
export async function emailWarningNames(gitDir: string): Promise<string[]> {
  const main = await resolveCommit(gitDir, MAIN_REF);
  if (!main) return [];
  const key = `${gitDir}\0${main}`;
  const hit = warningCache.get(key);
  if (hit) return hit;
  const { stdout } = await runGit(
    ['log', '--no-color', '--format=%an%x00%ae%x00%cn%x00%ce%x00', MAIN_REF, '--'],
    { gitDir, maxBuffer: 256 * 1024 * 1024, timeoutMs: 60_000 },
  );
  const parts = stdout.toString('utf8').split('\0');
  const names = new Set<string>();
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const pairs: [string, string][] = [
      [parts[i]!.replace(/^\n/, ''), parts[i + 1]!],
      [parts[i + 2]!, parts[i + 3]!],
    ];
    for (const [name, email] of pairs) {
      if (!isPrivateEmail(email)) names.add(name.trim() || 'Someone without a name');
    }
  }
  const list = [...names].sort((a, b) => a.localeCompare(b));
  if (warningCache.size > 500) warningCache.clear();
  warningCache.set(key, list);
  return list;
}
