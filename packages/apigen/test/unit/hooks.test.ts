/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Apigen, type Relation, relation } from '../../src/index.js';
import { createFixtureDb, FIXTURE_CATALOG, type TestDb } from '../helpers/db.js';

let db: TestDb;

beforeEach(async () => {
  db = await createFixtureDb();
});

afterEach(async () => {
  await db.end();
});

function build(rel: Relation): Apigen {
  return new Apigen({ db: db.sql, catalog: FIXTURE_CATALOG }).use(rel);
}

function get(app: Apigen, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

async function rows(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.json()) as Record<string, unknown>[];
}

test('an op with no authorization is public: USING true, all columns, 200', async () => {
  const app = build(relation('orders').select({}));

  const res = await get(app, '/orders');
  expect(res.status).toBe(200);

  const body = await rows(res);
  // Every seeded order is visible — the implicit policy is USING true.
  expect(body.map((r) => r.customer).sort()).toEqual(['Alice', 'Bob', 'Carol']);
  // Omitting allowedColumns exposes every catalog column.
  expect(Object.keys(body[0] ?? {}).sort()).toEqual([
    'amount',
    'created_at',
    'customer',
    'id',
    'org_id',
    'paid',
    'status',
  ]);
});

test('beforeExecute runs before the query, once per routed request', async () => {
  const fired: { op: string; relation: string }[] = [];
  const app = build(
    relation('orders').select({
      authorization: (_req, { sql }) => ({ policy: sql.using`true` }),
      beforeExecute: ({ op, relation }) => {
        fired.push({ op, relation });
      },
    }),
  );

  const res = await get(app, '/orders');
  expect(res.status).toBe(200);
  expect(fired).toEqual([{ op: 'select', relation: 'orders' }]);
});

test('afterExecute can modify the response, leaving the status unchanged', async () => {
  const app = build(
    relation('orders').select({
      authorization: (_req, { sql }) => ({ policy: sql.using`true` }),
      afterExecute: ({ response }) => {
        response.headers.set('x-apigen-hook', 'ran');
        return response;
      },
    }),
  );

  const res = await get(app, '/orders');
  expect(res.status).toBe(200);
  expect(res.headers.get('x-apigen-hook')).toBe('ran');
});
