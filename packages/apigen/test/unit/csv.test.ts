/**
 * Hermetic coverage for CSV output over an ephemeral PGlite, exercising the RFC-4180
 * quoting and null handling that the shared fixture's data can't (no commas or nulls).
 * The exact byte format (text values, header, no trailing newline) is proven against
 * PostgREST by the differential suite.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `create table items (id integer primary key, label text, qty integer);`;
const SEED = `
  insert into items (id, label, qty) values
    (1, 'plain', 5),
    (2, 'has, comma', 3),
    (3, null, null);
`;
const CATALOG: Catalog = { items: { id: 'int4', label: 'text', qty: 'int4' } };

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
  app = new Apigen({ db: db.sql, catalog: CATALOG }).use(relation('items').select({}));
});

afterEach(async () => {
  await db.end();
});

test('CSV: header + text values, quoting for commas, null → empty, no trailing newline', async () => {
  const res = await app.handle(
    new Request('http://localhost/items?select=id,label,qty&order=id', {
      headers: { accept: 'text/csv' },
    }),
  );
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(await res.text()).toBe('id,label,qty\n1,plain,5\n2,"has, comma",3\n3,,');
});
