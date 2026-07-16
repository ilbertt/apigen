import type { Adapter, PostgresLike, Query } from '../contract.js';
import { createAdapter } from './create.js';

/** The precise call surface both postgres.js and Bun.SQL expose at runtime. */
type PgRunner = {
  unsafe: (text: string, values: unknown[]) => PromiseLike<unknown[]>;
  begin: <T>(fn: (tx: PgRunner) => Promise<T>) => Promise<T>;
};

/**
 * The built-in adapter for postgres.js and Bun.SQL — they share one API surface
 * (`.unsafe(text, values)` + `.begin`). One transaction re-wraps the same shape
 * so nested `execute` runs on the transaction connection. The single cast bridges
 * the loose {@link PostgresLike} duck (already shape-detected) to {@link PgRunner}.
 */
export function createPostgresAdapter(db: PostgresLike): Adapter {
  const runner = db as unknown as PgRunner;
  const wrap = (r: PgRunner): Adapter =>
    createAdapter({
      execute: ({ text, values }: Query): Promise<unknown[]> =>
        Promise.resolve(r.unsafe(text, values)),
      transaction: <T>(fn: (tx: Adapter) => Promise<T>): Promise<T> =>
        r.begin((tx) => fn(wrap(tx))),
    });
  return wrap(runner);
}
