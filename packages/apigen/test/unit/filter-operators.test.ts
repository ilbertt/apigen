/**
 * End-to-end hermetic coverage for the compile paths that need exotic column types
 * (array, range, jsonb) against an ephemeral PGlite — the shared fixture has none of
 * them, and this avoids churning the codegen snapshots to add them. Behavior parity
 * with PostgREST is proven separately by the differential suite; this is the CI
 * regression net for the operator→symbol mapping and JSON-path projection in compile.ts.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table things (
    id integer primary key,
    tags text[] not null default '{}',
    span int4range,
    data jsonb,
    label text
  );
`;

const SEED = `
  insert into things (id, tags, span, data) values
    (1, '{vip,priority}', '[1,10)', '{"tier":"gold","age":30}'),
    (2, '{}', '[5,15)', '{"tier":"silver","age":25}'),
    (3, '{vip}', '[20,30)', '{"tier":"gold","age":40}');
`;

const CATALOG: Catalog = {
  things: { id: 'int4', tags: '_text', span: 'int4range', data: 'jsonb', label: 'text' },
};

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
  app = new Apigen({ db: db.sql, catalog: CATALOG }).use(relation('things').select({}));
});

afterEach(async () => {
  await db.end();
});

async function ids(query: string): Promise<unknown[]> {
  const res = await app.handle(new Request(`http://localhost/things?${query}`));
  const rows = (await res.json()) as { id: number }[];
  return rows.map((r) => r.id);
}

test('array operators: cs (contains) / cd (contained) / ov (overlap)', async () => {
  expect(await ids('tags=cs.{vip}&order=id')).toEqual([1, 3]);
  expect(await ids('tags=cd.{vip}&order=id')).toEqual([2, 3]);
  expect(await ids('tags=ov.{priority}&order=id')).toEqual([1]);
  expect(await ids('tags=not.cs.{vip}&order=id')).toEqual([2]);
});

test('range operators: cs / sl / sr / nxr / nxl / adj', async () => {
  expect(await ids('span=cs.[2,5)&order=id')).toEqual([1]);
  expect(await ids('span=sl.[20,30)&order=id')).toEqual([1, 2]);
  expect(await ids('span=sr.[1,3)&order=id')).toEqual([2, 3]);
  expect(await ids('span=nxr.[10,20)&order=id')).toEqual([1, 2]);
  expect(await ids('span=nxl.[10,20)&order=id')).toEqual([3]);
  expect(await ids('span=adj.[10,20)&order=id')).toEqual([1, 3]);
});

test('select: JSON-path projection extracts (->>/->), names by last key, and casts', async () => {
  const rows = async (query: string): Promise<unknown[]> =>
    (await (await app.handle(new Request(`http://localhost/things?${query}`))).json()) as unknown[];
  expect(await rows('select=id,data->>tier&order=id')).toEqual([
    { id: 1, tier: 'gold' },
    { id: 2, tier: 'silver' },
    { id: 3, tier: 'gold' },
  ]);
  // -> keeps json (a quoted string); an alias and a cast rename/retype the output.
  expect(await rows('select=plan:data->tier&order=id&id=eq.1')).toEqual([{ plan: 'gold' }]);
  expect(await rows('select=years:data->>age::int&order=id&id=eq.1')).toEqual([{ years: 30 }]);
});

// Regression: the write-representation re-select must read columns back by their OUTPUT
// name (outputName), not the base column. A JSON-path projection is labelled by its last
// key in RETURNING, so `select=id,data->>tier` re-selects `"tier"` — reading back "data"
// used to raise `column "data" does not exist` (400) on PATCH / upsert / missing=default.
// The JSON path is read off the pre-seeded jsonb (rows 1-3 have tier gold/silver/gold).
test('write representation projects a JSON path in select', async () => {
  const wapp = new Apigen({ db: db.sql, catalog: CATALOG }).use(
    relation('things').select({}).insert({}).update({}),
  );
  const write = ({
    method,
    path,
    body,
    prefer,
  }: {
    method: string;
    path: string;
    body: unknown;
    prefer: string;
  }): Promise<Response> =>
    wapp.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json', prefer },
        body: JSON.stringify(body),
      }),
    );

  // PATCH → compileUpdate re-select
  const patched = await write({
    method: 'PATCH',
    path: '/things?id=eq.1&select=id,data->>tier',
    body: { label: 'updated' },
    prefer: 'return=representation',
  });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toEqual([{ id: 1, tier: 'gold' }]);

  // POST upsert (existing id → UPDATE branch) → compileInsert(conflict) re-select
  const upserted = await write({
    method: 'POST',
    path: '/things?on_conflict=id&select=id,data->>tier',
    body: { id: 2, label: 'merged' },
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  expect(upserted.status).toBe(200);
  expect(await upserted.json()).toEqual([{ id: 2, tier: 'silver' }]);

  // POST missing=default (new row, data omitted → default null) → missingDefault re-select
  const inserted = await write({
    method: 'POST',
    path: '/things?select=id,data->>tier',
    body: { id: 4, label: 'fresh' },
    prefer: 'missing=default,return=representation',
  });
  expect(inserted.status).toBe(201);
  expect(await inserted.json()).toEqual([{ id: 4, tier: null }]);
});
