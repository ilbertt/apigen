/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Apigen, relation } from '../src/index.js';
import { createFixtureDb, FIXTURE_CATALOG, type Sql, type TestDb } from './helpers/db.js';

const ORG1 = '11111111-1111-1111-1111-111111111111';
const ORG2 = '22222222-2222-2222-2222-222222222222';

function orgOf(req: Request): string | false {
  return req.headers.get('x-org-id') ?? false;
}

function buildApp(sql: Sql): Apigen {
  const orders = relation('orders')
    .select({
      authorization: (req, { sql }) => {
        const org = orgOf(req);
        return org === false ? false : { policy: sql.using`org_id = ${org}::uuid` };
      },
    })
    .insert({
      authorization: (req, { sql }) => {
        const org = orgOf(req);
        return org === false
          ? false
          : {
              policy: sql.withCheck`org_id = ${org}::uuid`,
              allowedColumns: ['org_id', 'customer', 'amount', 'status', 'paid'],
            };
      },
    })
    .update({
      authorization: (req, { sql }) => {
        const org = orgOf(req);
        return org === false
          ? false
          : {
              policy: sql.using`org_id = ${org}::uuid`,
              allowedColumns: ['org_id', 'customer', 'amount', 'status', 'paid'],
            };
      },
    })
    .delete({
      authorization: (req, { sql }) => {
        const org = orgOf(req);
        return org === false ? false : { policy: sql.using`org_id = ${org}::uuid` };
      },
    });

  const orderItems = relation('order_items').select({
    authorization: (req, { sql }) => {
      const org = orgOf(req);
      return org === false
        ? false
        : { policy: sql.using`org_id = ${org}::uuid`, allowedColumns: ['id', 'sku', 'qty'] };
    },
  });

  return new Apigen({ db: sql, catalog: FIXTURE_CATALOG }).use(orders).use(orderItems);
}

let db: TestDb;
let app: Apigen;

beforeEach(async () => {
  db = await createFixtureDb();
  app = buildApp(db.sql);
});

afterEach(async () => {
  await db.end();
});

function get(path: string, org?: string): Promise<Response> {
  const headers = org ? { 'x-org-id': org } : undefined;
  return app.handle(new Request(`http://localhost${path}`, { headers }));
}

function send({
  method,
  path,
  org,
  body,
}: {
  method: string;
  path: string;
  org?: string;
  body?: unknown;
}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(org ? { 'x-org-id': org } : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function rows(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.json()) as Record<string, unknown>[];
}

test('tenant isolation: the USING policy scopes rows to the caller org', async () => {
  const org1 = await rows(await get('/orders', ORG1));
  expect(org1.map((r) => r.customer).sort()).toEqual(['Alice', 'Bob']);

  const org2 = await rows(await get('/orders', ORG2));
  expect(org2.map((r) => r.customer)).toEqual(['Carol']);
});

test('a denied policy (no org) returns 403', async () => {
  const res = await get('/orders');
  expect(res.status).toBe(403);
});

test('filters: eq / gte / in / like compose onto the policy', async () => {
  expect((await rows(await get('/orders?status=eq.paid', ORG1))).map((r) => r.customer)).toEqual([
    'Alice',
  ]);
  expect((await rows(await get('/orders?amount=gte.60', ORG1))).map((r) => r.customer)).toEqual([
    'Alice',
  ]);
  expect(
    (await rows(await get('/orders?customer=in.(Alice,Bob)&order=customer.asc', ORG1))).map(
      (r) => r.customer,
    ),
  ).toEqual(['Alice', 'Bob']);
  expect((await rows(await get('/orders?customer=like.A*', ORG1))).map((r) => r.customer)).toEqual([
    'Alice',
  ]);
});

test('order / limit / offset', async () => {
  const res = await get('/orders?order=amount.desc&limit=1', ORG1);
  expect((await rows(res)).map((r) => r.customer)).toEqual(['Alice']);

  const offset = await get('/orders?order=amount.desc&limit=1&offset=1', ORG1);
  expect((await rows(offset)).map((r) => r.customer)).toEqual(['Bob']);
});

test('?select projects only requested columns', async () => {
  const res = await get('/orders?select=customer,amount', ORG1);
  const [row] = await rows(res);
  expect(Object.keys(row ?? {}).sort()).toEqual(['amount', 'customer']);
});

test('forbidden column in ?select → 403', async () => {
  const res = await get('/order_items?select=price', ORG1);
  expect(res.status).toBe(403);
});

test('forbidden column in a filter → 403', async () => {
  const res = await get('/order_items?price=gte.10', ORG1);
  expect(res.status).toBe(403);
});

test('insert respects WITH CHECK: matching org inserts', async () => {
  const res = await send({
    method: 'POST',
    path: '/orders',
    org: ORG1,
    body: { org_id: ORG1, customer: 'Dave', amount: 10 },
  });
  expect(res.status).toBe(201);
  const [row] = await rows(res);
  expect(row).toMatchObject({ customer: 'Dave', org_id: ORG1 });

  const all = await rows(await get('/orders', ORG1));
  expect(all.map((r) => r.customer).sort()).toEqual(['Alice', 'Bob', 'Dave']);
});

test('insert violating WITH CHECK (wrong org in body) → 403, nothing inserted', async () => {
  const res = await send({
    method: 'POST',
    path: '/orders',
    org: ORG1,
    body: { org_id: ORG2, customer: 'Mallory', amount: 10 },
  });
  expect(res.status).toBe(403);

  const org2 = await rows(await get('/orders', ORG2));
  expect(org2.map((r) => r.customer)).toEqual(['Carol']);
});

test('update within scope succeeds', async () => {
  const res = await send({
    method: 'PATCH',
    path: '/orders?customer=eq.Bob',
    org: ORG1,
    body: { status: 'paid' },
  });
  expect(res.status).toBe(200);
  const [row] = await rows(res);
  expect(row).toMatchObject({ customer: 'Bob', status: 'paid' });
});

test('update that moves a row out of scope fails WITH CHECK and rolls back', async () => {
  const res = await send({
    method: 'PATCH',
    path: '/orders?customer=eq.Bob',
    org: ORG1,
    body: { org_id: ORG2 },
  });
  expect(res.status).toBe(403);

  // Bob is still visible to ORG1 — the update rolled back.
  const org1 = await rows(await get('/orders', ORG1));
  expect(org1.map((r) => r.customer).sort()).toEqual(['Alice', 'Bob']);
});

test('delete removes only in-scope rows', async () => {
  const res = await send({
    method: 'DELETE',
    path: '/orders?customer=eq.Bob',
    org: ORG1,
  });
  expect(res.status).toBe(200);
  expect(await rows(res)).toHaveLength(1);

  const remaining = await rows(await get('/orders', ORG1));
  expect(remaining.map((r) => r.customer)).toEqual(['Alice']);
});

test('delete cannot reach another org’s rows (silent filter)', async () => {
  const res = await send({
    method: 'DELETE',
    path: '/orders?customer=eq.Carol',
    org: ORG1,
  });
  expect(res.status).toBe(200);
  expect(await rows(res)).toHaveLength(0);

  const carol = await rows(await get('/orders', ORG2));
  expect(carol.map((r) => r.customer)).toEqual(['Carol']);
});
