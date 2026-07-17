import net from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres from 'postgres';
import type { Catalog } from '../../src/contract.js';

export type Sql = ReturnType<typeof postgres>;

export interface TestDb {
  sql: Sql;
  pglite: PGlite;
  end: () => Promise<void>;
}

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures');

/** Catalog for the fixture schema — hand-written until codegen produces it. */
export const FIXTURE_CATALOG: Catalog = {
  orgs: { id: 'uuid', name: 'text' },
  orders: {
    id: 'int8',
    org_id: 'uuid',
    customer: 'text',
    amount: 'numeric',
    status: 'text',
    paid: 'bool',
    created_at: 'timestamptz',
  },
  order_items: {
    id: 'int8',
    order_id: 'int8',
    org_id: 'uuid',
    sku: 'text',
    qty: 'int4',
    price: 'numeric',
  },
};

function getFreePort(): Promise<number> {
  // biome-ignore lint/complexity/useMaxParams: Promise executor signature is fixed by the language.
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spin up an ephemeral PGlite exposed over a socket, connected via postgres.js. */
export async function createTestDb({
  migrations,
  seed,
}: {
  migrations?: string;
  seed?: string;
} = {}): Promise<TestDb> {
  const pglite = await PGlite.create();
  if (migrations) {
    await pglite.exec(migrations);
  }
  if (seed) {
    await pglite.exec(seed);
  }

  const port = await getFreePort();
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await server.start();

  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    username: 'postgres',
    ssl: false,
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 1,
  });

  const end = async (): Promise<void> => {
    await sql.end({ timeout: 5 });
    await server.stop();
    await pglite.close();
  };

  return { sql, pglite, end };
}

/** A test database loaded with the shared fixture migrations + seed data. */
export async function createFixtureDb(): Promise<TestDb> {
  const migrations = await Bun.file(join(FIXTURES_DIR, 'migrations.sql')).text();
  const seed = await Bun.file(join(FIXTURES_DIR, 'seed.sql')).text();
  return createTestDb({ migrations, seed });
}

/**
 * Connect to an already-running Postgres by URL (the differential harness points
 * this at the Docker container). Unlike {@link createTestDb} this opens no PGlite —
 * the database lifecycle is owned by docker-compose.
 */
export function connectPostgres(url: string): { sql: Sql; end: () => Promise<void> } {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  return { sql, end: () => sql.end({ timeout: 5 }) };
}
