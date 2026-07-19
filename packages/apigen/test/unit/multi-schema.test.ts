/**
 * Hermetic coverage for multi-schema routing over an ephemeral PGlite: a relation in a
 * non-default schema is reached per request via Accept-Profile (reads) / Content-Profile
 * (writes), pinned with `search_path`, and every representation echoes Content-Profile.
 * Byte-for-byte parity with PostgREST is proven by the differential suite; this is the
 * CI regression net (and it guards that single-schema apps are entirely unaffected).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table items (id integer primary key, label text not null);
  create schema extra;
  create table extra.gadgets (id integer primary key, name text not null);
`;
const SEED = `
  insert into items (id, label) values (1, 'public-item');
  insert into extra.gadgets (id, name) values (1, 'first'), (2, 'second');
`;
const PUBLIC: Catalog = { items: { id: 'int4', label: 'text' } };
const EXTRA: Catalog = { gadgets: { id: 'int4', name: 'text' } };

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
  app = new Apigen({
    db: db.sql,
    catalog: PUBLIC,
    primaryKeys: { items: ['id'] },
    schemas: { extra: { catalog: EXTRA, primaryKeys: { gadgets: ['id'] } } },
  })
    .use(relation('items').select({}))
    .use(relation('gadgets', { schema: 'extra' }).select({}).insert({}));
});

afterEach(async () => {
  await db.end();
});

test('reads route to the schema named by Accept-Profile (and pin search_path)', async () => {
  // gadgets exists only in `extra`; with no profile it is not exposed in the default schema.
  const missing = await app.handle(new Request('http://x/gadgets'));
  expect(missing.status).toBe(404);

  const res = await app.handle(
    new Request('http://x/gadgets?order=id', { headers: { 'accept-profile': 'extra' } }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-profile')).toBe('extra');
  expect(await res.json()).toEqual([
    { id: 1, name: 'first' },
    { id: 2, name: 'second' },
  ]);
});

test('default-schema responses echo Content-Profile: <default> in multi-schema mode', async () => {
  const res = await app.handle(new Request('http://x/items'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-profile')).toBe('public');
});

test('writes route to the schema named by Content-Profile', async () => {
  const res = await app.handle(
    new Request('http://x/gadgets?select=id,name', {
      method: 'POST',
      headers: {
        'content-profile': 'extra',
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({ id: 3, name: 'third' }),
    }),
  );
  expect(res.status).toBe(201);
  expect(res.headers.get('content-profile')).toBe('extra');
  expect(await res.json()).toEqual([{ id: 3, name: 'third' }]);
});

test('reads ignore Content-Profile; writes ignore Accept-Profile', async () => {
  // A read carrying only Content-Profile does not reach the other schema.
  const read = await app.handle(
    new Request('http://x/gadgets', { headers: { 'content-profile': 'extra' } }),
  );
  expect(read.status).toBe(404);
  // A write carrying only Accept-Profile does not reach the other schema.
  const write = await app.handle(
    new Request('http://x/gadgets', {
      method: 'POST',
      headers: { 'accept-profile': 'extra', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 4, name: 'nope' }),
    }),
  );
  expect(write.status).toBe(404);
});

test('an unknown schema is a 406 PGRST106 listing the exposed schemas in order', async () => {
  const res = await app.handle(
    new Request('http://x/items', { headers: { 'accept-profile': 'nope' } }),
  );
  expect(res.status).toBe(406);
  expect(await res.json()).toEqual({
    code: 'PGRST106',
    details: null,
    hint: null,
    message: 'The schema must be one of the following: public, extra',
  });
});

test('mounting a relation in an undeclared schema throws at wiring time', () => {
  expect(() =>
    new Apigen({ db: db.sql, catalog: PUBLIC }).use(
      relation('gadgets', { schema: 'ghost' }).select({}),
    ),
  ).toThrow(/schema "ghost"/);
});

test('single-schema apps ignore profile headers and emit no Content-Profile', async () => {
  const solo = new Apigen({ db: db.sql, catalog: PUBLIC }).use(relation('items').select({}));
  const res = await solo.handle(
    new Request('http://x/items', { headers: { 'accept-profile': 'anything' } }),
  );
  // The header is ignored (not a 406), and no Content-Profile is added — byte-for-byte
  // with a single-schema PostgREST.
  expect(res.status).toBe(200);
  expect(res.headers.get('content-profile')).toBeNull();
});
