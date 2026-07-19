/**
 * End-to-end hermetic coverage for the array/range filter operators against an
 * ephemeral PGlite with array + range columns — the shared fixture has neither, and
 * this avoids churning the codegen snapshots to add them. Behavior parity with
 * PostgREST is proven separately by the differential suite; this is the CI regression
 * net for the operator→symbol mapping in compile.ts.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table things (
    id integer primary key,
    tags text[] not null default '{}',
    span int4range
  );
`;

const SEED = `
  insert into things (id, tags, span) values
    (1, '{vip,priority}', '[1,10)'),
    (2, '{}', '[5,15)'),
    (3, '{vip}', '[20,30)');
`;

const CATALOG: Catalog = {
  things: { id: 'int4', tags: '_text', span: 'int4range' },
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
