/**
 * End-to-end hermetic coverage for FK resource embedding against an ephemeral PGlite
 * (the shared fixture has no foreign keys). Byte-for-byte parity with PostgREST is
 * proven by the differential suite; this guards the one-to-many / many-to-one shapes
 * and the join direction in CI. Assertions compare parsed JSON, so jsonb key ordering
 * is normalized away here.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog, ForeignKeys, PrimaryKeys } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table authors (id integer primary key, name text not null);
  create table books (
    id integer primary key,
    author_id integer not null references authors (id),
    title text not null
  );
`;
const SEED = `
  insert into authors (id, name) values (1, 'Ada'), (2, 'Grace');
  insert into books (id, author_id, title) values (1, 1, 'Notes'), (2, 1, 'Essays');
`;
const CATALOG: Catalog = {
  authors: { id: 'int4', name: 'text' },
  books: { id: 'int4', author_id: 'int4', title: 'text' },
};
const PRIMARY_KEYS: PrimaryKeys = { authors: ['id'], books: ['id'] };
const FOREIGN_KEYS: ForeignKeys = {
  books: [{ columns: ['author_id'], foreignRelation: 'authors', foreignColumns: ['id'] }],
};

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
  app = new Apigen({
    db: db.sql,
    catalog: CATALOG,
    primaryKeys: PRIMARY_KEYS,
    foreignKeys: FOREIGN_KEYS,
  })
    .use(relation('authors').select({}))
    .use(relation('books').select({}));
});

afterEach(async () => {
  await db.end();
});

async function json(query: string): Promise<unknown> {
  return (await app.handle(new Request(`http://localhost${query}`))).json();
}

test('one-to-many: an author embeds its books as an array; no children → []', async () => {
  expect(await json('/authors?select=id,books(title)&order=id')).toEqual([
    { id: 1, books: [{ title: 'Notes' }, { title: 'Essays' }] },
    { id: 2, books: [] },
  ]);
});

test('many-to-one: a book embeds its author as an object (aliased)', async () => {
  expect(await json('/books?select=title,writer:authors(name)&order=id')).toEqual([
    { title: 'Notes', writer: { name: 'Ada' } },
    { title: 'Essays', writer: { name: 'Ada' } },
  ]);
});

test('!inner drops base rows that have no matching embed (Grace has no books)', async () => {
  expect(await json('/authors?select=name,books!inner(title)&order=id')).toEqual([
    { name: 'Ada', books: [{ title: 'Notes' }, { title: 'Essays' }] },
  ]);
});

test('embedded filter/order/limit scope the nested query', async () => {
  expect(await json('/authors?select=name,books(title)&books.title=eq.Notes&id=eq.1')).toEqual([
    { name: 'Ada', books: [{ title: 'Notes' }] },
  ]);
  expect(
    await json('/authors?select=name,books(title)&books.order=title.asc&books.limit=1&id=eq.1'),
  ).toEqual([{ name: 'Ada', books: [{ title: 'Essays' }] }]);
});

test('spread ...table flattens a to-one parent into the base row', async () => {
  expect(await json('/books?select=title,...authors(name)&order=id')).toEqual([
    { title: 'Notes', name: 'Ada' },
    { title: 'Essays', name: 'Ada' },
  ]);
});

test('embedding an unexposed or unrelated relation is a 400', async () => {
  const notExposed = await app.handle(new Request('http://localhost/authors?select=id,nope(x)'));
  expect(notExposed.status).toBe(400);
});
