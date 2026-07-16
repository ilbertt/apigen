/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, sql) by design. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { HttpStatus } from '../src/http.js';
import { Apigen, type Relation, relation } from '../src/index.js';
import { createFixtureDb, FIXTURE_CATALOG, type Sql, type TestDb } from './helpers/db.js';

const ORG1 = '11111111-1111-1111-1111-111111111111';
const ORG2 = '22222222-2222-2222-2222-222222222222';

function orgOf(req: Request): string | false {
  return req.headers.get('x-org-id') ?? false;
}

/** Mounts all four verbs on `name`, scoped by `org_id = <caller org>::uuid`. */
function mountOrgScoped({
  name,
  allowedColumns,
}: {
  name: string;
  allowedColumns: readonly string[];
}): Relation {
  return relation(name)
    .select((req, s) => {
      const org = orgOf(req);
      return org === false ? false : { policy: s.using`org_id = ${org}::uuid`, allowedColumns };
    })
    .insert((req, s) => {
      const org = orgOf(req);
      return org === false ? false : { policy: s.withCheck`org_id = ${org}::uuid`, allowedColumns };
    })
    .update((req, s) => {
      const org = orgOf(req);
      return org === false ? false : { policy: s.using`org_id = ${org}::uuid`, allowedColumns };
    })
    .delete((req, s) => {
      const org = orgOf(req);
      return org === false ? false : { policy: s.using`org_id = ${org}::uuid`, allowedColumns };
    });
}

function buildApp(sql: Sql): Apigen {
  const orders = mountOrgScoped({
    name: 'orders',
    allowedColumns: ['org_id', 'customer', 'amount', 'status', 'paid'],
  });
  const orderItems = mountOrgScoped({
    name: 'order_items',
    allowedColumns: ['org_id', 'order_id', 'sku', 'qty', 'price'],
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

interface TableCase {
  readonly name: string;
  /** Deterministically ordered so snapshots are stable. */
  readonly selectPath: string;
  readonly insertBody: Record<string, unknown>;
  /** Filter that targets exactly one org1 row. */
  readonly rowFilter: string;
  readonly updatePatch: Record<string, unknown>;
  readonly updatedField: string;
}

const INSERT_ORDER_AMOUNT = 10;
const EXISTING_ORG1_ORDER_ID = 1;
const INSERT_ITEM_QTY = 4;
const INSERT_ITEM_PRICE = 12.5;
const UPDATED_ITEM_QTY = 9;

const TABLES: readonly TableCase[] = [
  {
    name: 'orders',
    selectPath: '/orders?order=customer.asc',
    insertBody: {
      org_id: ORG1,
      customer: 'Dave',
      amount: INSERT_ORDER_AMOUNT,
      status: 'pending',
      paid: false,
    },
    rowFilter: 'customer=eq.Bob',
    updatePatch: { status: 'paid' },
    updatedField: 'status',
  },
  {
    name: 'order_items',
    selectPath: '/order_items?order=sku.asc',
    insertBody: {
      org_id: ORG1,
      order_id: EXISTING_ORG1_ORDER_ID,
      sku: 'THINGAMAJIG',
      qty: INSERT_ITEM_QTY,
      price: INSERT_ITEM_PRICE,
    },
    rowFilter: 'sku=eq.WIDGET',
    updatePatch: { qty: UPDATED_ITEM_QTY },
    updatedField: 'qty',
  },
];

for (const table of TABLES) {
  test(`${table.name}: select is scoped to the caller org (snapshot)`, async () => {
    const res = await get(table.selectPath, ORG1);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await rows(res)).toMatchSnapshot();
  });

  test(`${table.name}: an unscoped caller (no org) is denied`, async () => {
    const res = await get(table.selectPath);
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  test(`${table.name}: insert respects allowedColumns and the WITH CHECK policy (snapshot)`, async () => {
    const res = await send({
      method: 'POST',
      path: `/${table.name}`,
      org: ORG1,
      body: table.insertBody,
    });
    expect(res.status).toBe(HttpStatus.Created);
    expect(await rows(res)).toMatchSnapshot();
  });

  test(`${table.name}: insert into another org's scope is denied and nothing is written`, async () => {
    const foreignBody = { ...table.insertBody, org_id: ORG2 };
    const res = await send({
      method: 'POST',
      path: `/${table.name}`,
      org: ORG1,
      body: foreignBody,
    });
    expect(res.status).toBe(HttpStatus.Forbidden);

    const org1Rows = await rows(await get(table.selectPath, ORG1));
    const org2Rows = await rows(await get(table.selectPath, ORG2));
    expect(org1Rows.some((row) => row.org_id === ORG2)).toBe(false);
    expect(org2Rows.some((row) => row.org_id === ORG1)).toBe(false);
  });

  test(`${table.name}: update within scope changes the target row`, async () => {
    const res = await send({
      method: 'PATCH',
      path: `/${table.name}?${table.rowFilter}`,
      org: ORG1,
      body: table.updatePatch,
    });
    expect(res.status).toBe(HttpStatus.Ok);

    const [row] = await rows(res);
    expect(row?.[table.updatedField]).toEqual(table.updatePatch[table.updatedField]);
  });

  test(`${table.name}: delete removes only the in-scope row`, async () => {
    const before = await rows(await get(table.selectPath, ORG1));

    const res = await send({
      method: 'DELETE',
      path: `/${table.name}?${table.rowFilter}`,
      org: ORG1,
    });
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await rows(res)).toHaveLength(1);

    const after = await rows(await get(table.selectPath, ORG1));
    expect(after.length).toBe(before.length - 1);

    const otherOrg = await rows(await get(table.selectPath, ORG2));
    expect(otherOrg).toHaveLength(1);
  });
}
