import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createAdapter, createPostgresAdapter } from '../src/adapters/index.js';
import type { Adapter } from '../src/contract.js';
import { createFixtureDb, type TestDb } from './helpers/db.js';

const COMMITTED_ORG_ID = '44444444-4444-4444-4444-444444444444';
const ROLLBACK_ORG_ID = '33333333-3333-3333-3333-333333333333';

test('createAdapter returns the same object when execute/transaction are present', () => {
  const adapter: Adapter = {
    execute: (): Promise<unknown[]> => Promise.resolve([]),
    transaction: <T>(fn: (tx: Adapter) => Promise<T>): Promise<T> => fn(adapter),
  };
  expect(createAdapter(adapter)).toBe(adapter);
});

test('createAdapter throws a TypeError when both methods are missing', () => {
  expect(() => createAdapter({} as Adapter)).toThrow(TypeError);
});

test('createAdapter throws a TypeError when only transaction is present', () => {
  const partial = {
    transaction: (): Promise<undefined> => Promise.resolve(undefined),
  } as unknown as Adapter;
  expect(() => createAdapter(partial)).toThrow(TypeError);
});

test('createAdapter throws a TypeError when only execute is present', () => {
  const partial = { execute: (): Promise<unknown[]> => Promise.resolve([]) } as unknown as Adapter;
  expect(() => createAdapter(partial)).toThrow(TypeError);
});

let db: TestDb;

beforeEach(async () => {
  db = await createFixtureDb();
});

afterEach(async () => {
  await db.end();
});

test('createPostgresAdapter#execute runs a real parameterized query', async () => {
  const adapter = createPostgresAdapter(db.sql);
  const rows = await adapter.execute({
    text: 'select customer from orders where customer = $1',
    values: ['Alice'],
  });
  expect(rows).toEqual([{ customer: 'Alice' }]);
});

test('createPostgresAdapter#transaction commits when the callback resolves', async () => {
  const adapter = createPostgresAdapter(db.sql);
  await adapter.transaction((tx) =>
    tx.execute({
      text: 'insert into orgs (id, name) values ($1, $2)',
      values: [COMMITTED_ORG_ID, 'Initech'],
    }),
  );

  const rows = await adapter.execute({
    text: 'select name from orgs where id = $1',
    values: [COMMITTED_ORG_ID],
  });
  expect(rows).toEqual([{ name: 'Initech' }]);
});

test('createPostgresAdapter#transaction rolls back when the callback throws', async () => {
  const adapter = createPostgresAdapter(db.sql);
  const attempt = adapter.transaction(async (tx) => {
    await tx.execute({
      text: 'insert into orgs (id, name) values ($1, $2)',
      values: [ROLLBACK_ORG_ID, 'Ghost Co'],
    });
    throw new Error('boom');
  });

  await expect(attempt).rejects.toThrow('boom');

  const rows = await adapter.execute({
    text: 'select name from orgs where id = $1',
    values: [ROLLBACK_ORG_ID],
  });
  expect(rows).toEqual([]);
});
