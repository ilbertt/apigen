import { resolveAdapter } from '../adapters/resolve.js';
import type { DbInput } from '../contract.js';
import { emit } from './emit.js';
import {
  introspect,
  introspectFunctions,
  introspectPrimaryKeys,
  type RunQuery,
} from './introspect.js';

/**
 * Load PGlite lazily so codegen fails with a clear message — not an opaque module
 * resolution error — when the optional peer isn't installed. PGlite is a
 * codegen-only dependency; nothing here runs in the request path.
 */
async function loadPGlite(): Promise<typeof import('@electric-sql/pglite').PGlite> {
  try {
    return (await import('@electric-sql/pglite')).PGlite;
  } catch {
    throw new Error(
      'apigen codegen requires @electric-sql/pglite. Install it as a dev dependency:\n  bun add -d @electric-sql/pglite',
    );
  }
}

/**
 * Introspect a schema by loading `migrations` into an ephemeral PGlite, then emit
 * the `api.gen.ts` source.
 */
export async function generateFromSql({
  migrations,
  moduleSpecifier,
}: {
  migrations: string;
  moduleSpecifier?: string;
}): Promise<string> {
  const PGlite = await loadPGlite();
  const db = await PGlite.create();
  try {
    await db.exec(migrations);
    const run: RunQuery = async (sql) => (await db.query(sql)).rows;
    const introspection = await introspect(run);
    const functions = await introspectFunctions(run);
    const primaryKeys = await introspectPrimaryKeys(run);
    return emit({ introspection, functions, primaryKeys, moduleSpecifier });
  } finally {
    await db.close();
  }
}

/**
 * Introspect a live Postgres connection directly — no migrations, no PGlite — and
 * emit the `api.gen.ts` source. The caller owns the connection's lifecycle.
 */
export async function generateFromDb({
  db,
  moduleSpecifier,
}: {
  db: DbInput;
  moduleSpecifier?: string;
}): Promise<string> {
  const adapter = resolveAdapter(db);
  const run: RunQuery = (sql) => adapter.execute({ text: sql, values: [] });
  const introspection = await introspect(run);
  const functions = await introspectFunctions(run);
  const primaryKeys = await introspectPrimaryKeys(run);
  return emit({ introspection, functions, primaryKeys, moduleSpecifier });
}
