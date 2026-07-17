import { resolveAdapter } from '../adapters/resolve.js';
import type { DbInput } from '../contract.js';
import { emit } from './emit.js';
import { introspect } from './introspect.js';

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
    const introspection = await introspect(async (sql) => (await db.query(sql)).rows);
    return emit({ introspection, moduleSpecifier });
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
  const introspection = await introspect((sql) => adapter.execute({ text: sql, values: [] }));
  return emit({ introspection, moduleSpecifier });
}
