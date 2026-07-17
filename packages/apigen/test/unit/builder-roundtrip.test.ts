import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPostgresAdapter } from '../../src/adapters/index.js';
import { join, type Sql, sql } from '../../src/builder/index.js';
import type { Adapter } from '../../src/contract.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

let db: TestDb;
let adapter: Adapter;

beforeAll(async () => {
  db = await createTestDb({ migrations: 'create table t (id int, name text);' });
  adapter = createPostgresAdapter(db.sql);
});

afterAll(async () => {
  await db.end();
});

function run(fragment: Sql): Promise<unknown[]> {
  return adapter.execute({ text: fragment.text, values: fragment.values });
}

test('vendored builder composes fragments and round-trips through postgres.js', async () => {
  await run(sql`insert into t (id, name) values (${1}, ${'alice'}), (${2}, ${'bob'})`);

  const idFilter = sql`id = ${1}`;
  const rows = await run(sql`select id, name from t where ${idFilter}`);
  expect(rows).toEqual([{ id: 1, name: 'alice' }]);
});

test('join() offsets params correctly across a nested list', async () => {
  const ids = [1, 2];
  const list = join({ values: ids.map((v) => sql`${v}`), separator: ', ' });
  const rows = await run(sql`select id from t where id in (${list}) order by id`);
  expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
});

test('a hostile string stays a bound value, never SQL', async () => {
  const hostile = '1); drop table t; --';
  const rows = await run(sql`select id from t where name = ${hostile}`);
  expect(rows).toEqual([]);

  const [count] = await run(sql`select count(*)::int as n from t`);
  expect((count as { n: number }).n).toBe(2);
});

test('transaction runs composed fragments on the tx connection', async () => {
  const result = await adapter.transaction((tx) => {
    const q = sql`select ${21}::int * ${2}::int as answer`;
    return tx.execute({ text: q.text, values: q.values });
  });
  expect(result).toEqual([{ answer: 42 }]);
});
