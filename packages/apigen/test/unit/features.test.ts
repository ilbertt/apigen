/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Apigen, relation } from '../../src/index.js';
import { createFixtureDb, FIXTURE_CATALOG, type Sql, type TestDb } from '../helpers/db.js';
import { REPRESENTATION } from '../helpers/http.js';

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

  const primaryKeys = { orders: ['id'], order_items: ['id'], orgs: ['id'] };
  return new Apigen({ db: sql, catalog: FIXTURE_CATALOG, primaryKeys }).use(orders).use(orderItems);
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
  prefer,
}: {
  method: string;
  path: string;
  org?: string;
  body?: unknown;
  prefer?: string;
}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(org ? { 'x-org-id': org } : {}),
        ...(prefer ? { prefer } : {}),
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

test('filters: match / imatch / isdistinct / negation compose onto the policy', async () => {
  const customers = async (query: string): Promise<unknown[]> =>
    (await rows(await get(query, ORG1))).map((r) => r.customer);
  // ORG1 rows: Alice (paid, true), Bob (pending, false).
  expect(await customers('/orders?customer=match.^A')).toEqual(['Alice']);
  expect(await customers('/orders?customer=imatch.^a')).toEqual(['Alice']);
  expect(await customers('/orders?customer=isdistinct.Alice')).toEqual(['Bob']);
  expect(await customers('/orders?customer=not.eq.Alice')).toEqual(['Bob']);
  expect(await customers('/orders?customer=not.like.A*')).toEqual(['Bob']);
  expect(await customers('/orders?paid=not.is.true')).toEqual(['Bob']);
});

test('filters: full-text search matches lexemes in a text column', async () => {
  const customers = async (query: string): Promise<unknown[]> =>
    (await rows(await get(query, ORG1))).map((r) => r.customer);
  // to_tsvector lowercases to a lexeme, so the query casing does not matter.
  expect(await customers('/orders?customer=fts.Alice')).toEqual(['Alice']);
  expect(await customers('/orders?customer=fts(english).alice')).toEqual(['Alice']);
  expect(await customers('/orders?customer=wfts.bob')).toEqual(['Bob']);
  expect(await customers('/orders?customer=not.fts.Alice')).toEqual(['Bob']);
});

test('filters: any/all quantifiers apply the operator across a {…} list', async () => {
  const customers = async (query: string): Promise<unknown[]> =>
    (await rows(await get(query, ORG1))).map((r) => r.customer);
  // ORG1 rows: Alice (id 1, amount 100), Bob (id 2, amount 50.5).
  expect(await customers('/orders?id=eq(any).{1,2}&order=id')).toEqual(['Alice', 'Bob']);
  expect(await customers('/orders?customer=like(any).{A*,B*}&order=id')).toEqual(['Alice', 'Bob']);
  expect(await customers('/orders?customer=like(all).{A*,*e}')).toEqual(['Alice']);
  expect(await customers('/orders?amount=gt(all).{40,60}')).toEqual(['Alice']);
});

test('filters: logical or/and/not.and compose with the policy', async () => {
  const customers = async (query: string): Promise<unknown[]> =>
    (await rows(await get(query, ORG1))).map((r) => r.customer);
  // ORG1 rows: Alice (paid, true), Bob (pending, false).
  expect(
    await customers('/orders?or=(customer.eq.Alice,customer.eq.Bob)&order=customer.asc'),
  ).toEqual(['Alice', 'Bob']);
  expect(await customers('/orders?and=(status.eq.paid,paid.is.true)')).toEqual(['Alice']);
  expect(await customers('/orders?not.and=(status.eq.paid,paid.is.true)')).toEqual(['Bob']);
});

test('select: rename (alias:col) and cast (col::type) reshape the projection', async () => {
  const res = await get('/orders?select=who:customer,amount::text&order=customer.asc', ORG1);
  expect(await rows(res)).toEqual([
    { who: 'Alice', amount: '100.00' },
    { who: 'Bob', amount: '50.50' },
  ]);
});

test('select: a PATCH representation honors rename/cast in RETURNING', async () => {
  const res = await send({
    method: 'PATCH',
    path: '/orders?customer=eq.Alice&select=who:customer,amount::text',
    org: ORG1,
    body: { status: 'shipped' },
    prefer: REPRESENTATION,
  });
  expect(await rows(res)).toEqual([{ who: 'Alice', amount: '100.00' }]);
});

test('writes: return=headers-only yields 201 + a PK-derived Location and no body', async () => {
  const res = await send({
    method: 'POST',
    path: '/orders',
    org: ORG1,
    body: { org_id: ORG1, customer: 'Zed', amount: 5 },
    prefer: 'return=headers-only',
  });
  expect(res.status).toBe(201);
  expect(res.headers.get('location')).toMatch(/^\/orders\?id=eq\.\d+$/);
  expect(res.headers.get('preference-applied')).toBe('return=headers-only');
  expect(await res.text()).toBe('');
});

test('order / limit / offset', async () => {
  const res = await get('/orders?order=amount.desc&limit=1', ORG1);
  expect((await rows(res)).map((r) => r.customer)).toEqual(['Alice']);

  const offset = await get('/orders?order=amount.desc&limit=1&offset=1', ORG1);
  expect((await rows(offset)).map((r) => r.customer)).toEqual(['Bob']);
});

test('pagination: the Range header offsets/limits, and limit/offset params win over it', async () => {
  const withRange = (query: string, range: string): Promise<Response> =>
    app.handle(new Request(`http://localhost${query}`, { headers: { 'x-org-id': ORG1, range } }));
  // ORG1 in id order: Alice, Bob. Range 0-0 → first row only.
  const first = await withRange('/orders?order=id', '0-0');
  expect((await rows(first)).map((r) => r.customer)).toEqual(['Alice']);
  expect(first.headers.get('content-range')).toBe('0-0/*');
  // A limit/offset query param takes precedence over the legacy Range header.
  const overridden = await withRange('/orders?order=id&limit=2', '0-0');
  expect((await rows(overridden)).map((r) => r.customer)).toEqual(['Alice', 'Bob']);
});

test('an unparseable Range header is a 400', async () => {
  const res = await app.handle(
    new Request('http://localhost/orders?order=id', {
      headers: { 'x-org-id': ORG1, range: 'abc' },
    }),
  );
  expect(res.status).toBe(400);
});

test('HEAD mirrors GET headers with no body; OPTIONS lists the mounted methods', async () => {
  const head = await app.handle(
    new Request('http://localhost/orders?order=id', {
      method: 'HEAD',
      headers: { 'x-org-id': ORG1 },
    }),
  );
  expect(head.status).toBe(200);
  expect(head.headers.get('content-range')).toBe('0-1/*');
  expect(await head.text()).toBe('');

  const options = await app.handle(new Request('http://localhost/orders', { method: 'OPTIONS' }));
  expect(options.status).toBe(200);
  expect(options.headers.get('allow')).toBe('OPTIONS,GET,HEAD,POST,PUT,PATCH,DELETE');

  // order_items mounts only select → only the read methods are allowed.
  const items = await app.handle(
    new Request('http://localhost/order_items', { method: 'OPTIONS' }),
  );
  expect(items.headers.get('allow')).toBe('OPTIONS,GET,HEAD');
});

test('aggregates: sum / count / grouped with an implicit GROUP BY', async () => {
  // ORG1: Alice (100.00, paid), Bob (50.50, pending).
  const [total] = await rows(await get('/orders?select=amount.sum(),count()', ORG1));
  expect(total).toEqual({ sum: 150.5, count: 2 });
  expect(await rows(await get('/orders?select=status,amount.sum()&order=status', ORG1))).toEqual([
    { status: 'paid', sum: 100 },
    { status: 'pending', sum: 50.5 },
  ]);
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
    prefer: REPRESENTATION,
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
    prefer: REPRESENTATION,
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
    prefer: REPRESENTATION,
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
    prefer: REPRESENTATION,
  });
  expect(res.status).toBe(200);
  expect(await rows(res)).toHaveLength(0);

  const carol = await rows(await get('/orders', ORG2));
  expect(carol.map((r) => r.customer)).toEqual(['Carol']);
});
