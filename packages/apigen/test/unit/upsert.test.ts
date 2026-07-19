/**
 * End-to-end hermetic coverage for POST upsert against an ephemeral PGlite with a
 * settable natural PK (the shared fixture's orders.id is `generated always`, so it
 * can't take an explicit id). Byte-for-byte parity is proven by the differential
 * suite; this guards the status (200-on-update vs 201-on-insert) and DO NOTHING
 * behavior in CI.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table products (
    sku text primary key,
    name text not null,
    price numeric(12, 2) not null default 0
  );
`;
const SEED = `insert into products (sku, name, price) values ('WIDGET', 'Widget', 25.00);`;
const CATALOG: Catalog = { products: { sku: 'text', name: 'text', price: 'numeric' } };
const PRIMARY_KEYS = { products: ['sku'] };

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
  app = new Apigen({ db: db.sql, catalog: CATALOG, primaryKeys: PRIMARY_KEYS }).use(
    relation('products').insert({}).select({}),
  );
});

afterEach(async () => {
  await db.end();
});

function upsert({
  body,
  resolution,
  path = '/products?on_conflict=sku',
}: {
  body: unknown;
  resolution: 'merge-duplicates' | 'ignore-duplicates';
  path?: string;
}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        prefer: `resolution=${resolution},return=representation`,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function names(query: string): Promise<unknown[]> {
  const res = await app.handle(new Request(`http://localhost${query}`));
  return ((await res.json()) as { name: string }[]).map((r) => r.name);
}

test('merge-duplicates: an existing conflict updates the row and answers 200', async () => {
  const res = await upsert({
    body: { sku: 'WIDGET', name: 'Widget v2', price: 30 },
    resolution: 'merge-duplicates',
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { name: string }[]).map((r) => r.name)).toEqual(['Widget v2']);
});

test('merge-duplicates: a new row inserts and answers 201', async () => {
  const res = await upsert({
    body: { sku: 'GADGET', name: 'Gadget', price: 5 },
    resolution: 'merge-duplicates',
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { name: string }[]).map((r) => r.name)).toEqual(['Gadget']);
});

test('ignore-duplicates: an existing conflict does nothing, 201 + empty body', async () => {
  const res = await upsert({
    body: { sku: 'WIDGET', name: 'IGNORED', price: 99 },
    resolution: 'ignore-duplicates',
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual([]);
  expect(await names('/products?sku=eq.WIDGET')).toEqual(['Widget']); // unchanged
});

test('the conflict target defaults to the PK when on_conflict is absent', async () => {
  const res = await upsert({
    body: { sku: 'WIDGET', name: 'Widget PK', price: 26 },
    resolution: 'merge-duplicates',
    path: '/products',
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { name: string }[]).map((r) => r.name)).toEqual(['Widget PK']);
});
