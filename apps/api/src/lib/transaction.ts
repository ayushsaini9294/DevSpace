import { env } from '../config/env.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from './prisma.ts';

/**
 * Transactions with "after commit" effects (Phase 9). Live updates and notification pushes must
 * only go out once the change they describe is committed, so code inside a transaction queues
 * them with `afterCommit(tx, effect)`; `transaction()` runs the queue after a successful commit
 * (and drops it on rollback). Every transaction that records activity uses `transaction()`.
 */

type Effect = () => Promise<void> | void;

interface Pending {
  effects: Effect[];
}

const pending = new WeakMap<object, Pending>();

type TxOptions = Parameters<typeof prisma.$transaction>[1];

/** Like `prisma.$transaction(fn, options)`, then runs the effects queued with `afterCommit`. */
export async function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  const state: Pending = { effects: [] };
  const result = await prisma.$transaction(async (tx) => {
    pending.set(tx, state);
    return fn(tx);
  }, options);
  await runEffects(state.effects);
  return result;
}

/** Effects never throw into the request: a failed push is logged (the data is committed). */
async function runEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (err) {
      console.error('After-commit effect failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Queues `effect` to run after `db`'s transaction commits. With the plain client (no
 * transaction: the write already happened) it runs right away. A transaction not started by
 * `transaction()` is a bug: tests fail loudly; elsewhere it is logged and runs right away.
 */
export async function afterCommit(db: object, effect: Effect): Promise<void> {
  const state = pending.get(db);
  if (state) {
    state.effects.push(effect);
    return;
  }
  if (db !== prisma) {
    const message = 'afterCommit() inside a transaction not started with transaction()';
    if (env.NODE_ENV === 'test') throw new Error(message);
    console.error(message);
  }
  await runEffects([effect]);
}

/** The pending state of a transaction (for merging several effects into one, e.g. invalidations). */
export function transactionState<T extends object>(
  db: object,
  key: symbol,
  init: () => T,
): T | null {
  const state = pending.get(db) as (Pending & Record<symbol, unknown>) | undefined;
  if (!state) return null;
  if (!(key in state)) state[key] = init();
  return state[key] as T;
}
