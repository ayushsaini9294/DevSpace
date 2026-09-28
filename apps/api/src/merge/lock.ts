import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';

/**
 * Advisory locks (released when their transaction ends).
 *
 * - The **project lock** (Phase 7): merge, revert, the conflict re-check and copy updates of one
 *   project run one at a time, so main never moves under a running operation.
 * - The **copy's submission lock** (Phase 6): submit, update and suggestion accept of one copy.
 *
 * Order: whoever needs both takes the copy's lock first, then the project's. Nothing takes them
 * the other way round, so they can't deadlock.
 */

export type Tx = Prisma.TransactionClient;

/** Git work (merges, whole-copy snapshots, writing files) happens inside: allow plenty. */
const TX_OPTIONS = { maxWait: 60_000, timeout: 300_000 } as const;

export async function lockCopySubmissions(tx: Tx, copyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('devspace.submission'), hashtext(${copyId}))`;
}

export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('devspace.project'), hashtext(${projectId}))`;
}

/** Runs `fn` in a transaction holding the copy's submission lock. */
export async function withCopySubmissionLock<T>(
  copyId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockCopySubmissions(tx, copyId);
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * Runs `fn` in a transaction holding the project's lock (and first, when `copyId` is given, that
 * copy's submission lock, so a copy update can't interleave with that member's submit).
 */
export async function withProjectLock<T>(
  projectId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { copyId?: string } = {},
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (options.copyId) await lockCopySubmissions(tx, options.copyId);
    await lockProject(tx, projectId);
    return fn(tx);
  }, TX_OPTIONS);
}
