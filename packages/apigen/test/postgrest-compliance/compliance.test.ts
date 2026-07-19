/**
 * PostgREST compliance: fire each {@link CASES} spec at a real PostgREST and at
 * apigen in-process, both backed by the SAME Postgres, and assert the responses
 * match. This is the compliance oracle — expected values come from PostgREST, not
 * from our reading of the docs.
 *
 * Self-contained: `beforeAll` brings the Docker stack up and `afterAll` tears it
 * down, so there is no env gate. It lives in its own folder and is NOT part of the
 * default unit-test command (which stays hermetic and Docker-free) — run it with:
 *
 *   bun run test:postgrest-compliance
 *
 * Both systems share one database, so each case reseeds to a deterministic state
 * before EACH side — writes don't cross-contaminate and there is no now() drift.
 * That shared-DB reset is why the cases run serially and can't be `test.concurrent`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { introspect, introspectPrimaryKeys } from '../../src/codegen/introspect.js';
import type { Catalog, PrimaryKeys } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { connectPostgres, type Sql } from '../helpers/db.js';
import { CASES, type DiffCase } from './cases.js';

// Ports are fixed by docker-compose.yml, which this suite brings up. Use 127.0.0.1
// (not `localhost`) so a stray IPv6 listener on ::1 can't shadow the IPv4 publish.
const POSTGREST_URL = 'http://127.0.0.1:3000';
const APIGEN_PG_URL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
const COMPOSE_FILE = join(import.meta.dir, 'docker-compose.yml');

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const STACK_UP_TIMEOUT_MS = 180_000;
const STACK_DOWN_TIMEOUT_MS = 60_000;

/** Headers that carry semantic meaning for compliance; everything else is ignored. */
const HEADER_KEYS = [
  'content-type',
  'content-range',
  'range-unit',
  'location',
  'preference-applied',
];

interface Snapshot {
  status: number;
  headers: Record<string, string>;
  /** Raw body text — compared byte-for-byte, so numeric scale/timestamp format count. */
  body: string;
}

let sql: Sql;
let endDb: () => Promise<void>;
let app: Apigen;
/** seed.sql: pinned created_at + restarted identity → a fully deterministic reset. */
let seedSql: string;

/**
 * Build the catalog apigen runs against by introspecting the live container with
 * apigen's own {@link introspect} — the same code path the CLI uses. Dogfoods
 * introspection and removes any hand-written catalog that could drift as the schema
 * grows to cover more PostgREST features.
 */
async function introspectCatalog(db: Sql): Promise<Catalog> {
  const introspection = await introspect((text) => db.unsafe(text));
  const catalog: Catalog = {};
  for (const [name, columns] of Object.entries(introspection)) {
    catalog[name] = Object.fromEntries(columns.map((c) => [c.name, c.pgType]));
  }
  return catalog;
}

function buildApp({
  db,
  catalog,
  primaryKeys,
}: {
  db: Sql;
  catalog: Catalog;
  primaryKeys: PrimaryKeys;
}): Apigen {
  const mount = (name: string) => relation(name).select({}).insert({}).update({}).delete({});
  return new Apigen({ db, catalog, primaryKeys })
    .use(mount('orders'))
    .use(mount('order_items'))
    .use(mount('orgs'))
    .use(mount('products'));
}

async function waitForPostgrest(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const res = await fetch(POSTGREST_URL);
      if (res.ok) {
        return;
      }
    } catch {
      // PostgREST not accepting connections yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`PostgREST not reachable at ${POSTGREST_URL} within ${READY_TIMEOUT_MS}ms`);
}

function buildHeaders(c: DiffCase): Record<string, string> {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.body !== undefined && !('content-type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function requestInit(c: DiffCase): RequestInit {
  return {
    method: c.method,
    headers: buildHeaders(c),
    body: c.body === undefined ? undefined : JSON.stringify(c.body),
  };
}

async function normalize(res: Response): Promise<Snapshot> {
  const headers: Record<string, string> = {};
  for (const key of HEADER_KEYS) {
    const value = res.headers.get(key);
    if (value !== null) {
      headers[key] = value;
    }
  }
  return { status: res.status, headers, body: await res.text() };
}

function hitPostgrest(c: DiffCase): Promise<Snapshot> {
  return fetch(`${POSTGREST_URL}${c.path}`, requestInit(c)).then(normalize);
}

function hitApigen(c: DiffCase): Promise<Snapshot> {
  return app.handle(new Request(`http://apigen.local${c.path}`, requestInit(c))).then(normalize);
}

async function reseed(): Promise<void> {
  await sql.unsafe(seedSql);
}

describe('PostgREST compliance', () => {
  beforeAll(async () => {
    await $`docker compose -f ${COMPOSE_FILE} up -d --wait`.quiet();
    seedSql = await Bun.file(join(import.meta.dir, 'seed.sql')).text();
    const conn = connectPostgres(APIGEN_PG_URL);
    sql = conn.sql;
    endDb = conn.end;
    const primaryKeys: PrimaryKeys = await introspectPrimaryKeys((text) => sql.unsafe(text));
    app = buildApp({ db: sql, catalog: await introspectCatalog(sql), primaryKeys });
    await waitForPostgrest();
  }, STACK_UP_TIMEOUT_MS);

  afterAll(async () => {
    await endDb?.();
    await $`docker compose -f ${COMPOSE_FILE} down -v`.quiet();
  }, STACK_DOWN_TIMEOUT_MS);

  test.each(CASES)('$name', async (c) => {
    await reseed();
    const expected = await hitPostgrest(c);
    await reseed();
    const actual = await hitApigen(c);
    expect(actual).toEqual(expected);
  });
});
