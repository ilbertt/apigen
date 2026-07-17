/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Apigen, relation } from '../src/index.js';
import { createFixtureDb, FIXTURE_CATALOG, type TestDb } from './helpers/db.js';

let db: TestDb;
let app: Apigen;

beforeAll(async () => {
  db = await createFixtureDb();
  const orders = relation('orders').select((_req, { sql }) => ({ policy: sql.using`true` }));
  app = new Apigen({ db: db.sql, catalog: FIXTURE_CATALOG }).use(orders);
});

afterAll(async () => {
  await db.end();
});

test('GET /orders returns every row as JSON', async () => {
  const res = await app.handle(new Request('http://localhost/orders'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');

  const body = (await res.json()) as Record<string, unknown>[];
  expect(body).toHaveLength(3);

  const alice = body.find((r) => r.customer === 'Alice');
  expect(alice).toMatchObject({
    org_id: '11111111-1111-1111-1111-111111111111',
    customer: 'Alice',
    amount: '100.00',
    status: 'paid',
    paid: true,
  });
  // int8 / numeric surfaced as strings
  expect(typeof alice?.id).toBe('string');
  expect(typeof alice?.amount).toBe('string');
});

test('an unmounted op is denied', async () => {
  const res = await app.handle(
    new Request('http://localhost/orders', {
      method: 'DELETE',
    }),
  );
  expect(res.status).toBe(403);
});

test('an unknown relation is 404', async () => {
  const res = await app.handle(new Request('http://localhost/widgets'));
  expect(res.status).toBe(404);
});
