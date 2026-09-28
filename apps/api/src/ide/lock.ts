import type { Prisma } from '../generated/prisma/client.ts';
import { transaction } from '../lib/transaction.ts';

/**
 * Runs `fn` in a transaction holding a PostgreSQL advisory lock for one copy. The API (deciding
 * whether to start a copy's IDE) and the worker (stopping an idle one) both take it, so across
 * processes the two never interleave: whichever comes second sees the other's result.
 * The lock is released when the transaction ends.
 */
export async function withCopyDbLock<T>(
  copyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('devspace.copy'), hashtext(${copyId}))`;
      return fn(tx);
    },
    // Stopping a container inside the lock takes about a second; allow plenty.
    { maxWait: 10_000, timeout: 60_000 },
  );
}
