import type { Adapter, DbInput, PostgresLike } from '../contract.js';
import { createPostgresAdapter } from './postgres.js';

function isAdapter(db: DbInput): db is Adapter {
  return (
    typeof (db as Adapter).execute === 'function' &&
    typeof (db as Adapter).transaction === 'function'
  );
}

function isPostgresLike(db: DbInput): db is PostgresLike {
  return (
    typeof (db as PostgresLike).unsafe === 'function' &&
    typeof (db as PostgresLike).begin === 'function'
  );
}

/** Accept an Adapter as-is; wrap a postgres.js/Bun.SQL instance by shape. */
export function resolveAdapter(db: DbInput): Adapter {
  if (isAdapter(db)) {
    return db;
  }
  if (isPostgresLike(db)) {
    return createPostgresAdapter(db);
  }
  throw new TypeError(
    'Apigen `db` must be a postgres.js/Bun.SQL instance or an Adapter from createAdapter()',
  );
}
