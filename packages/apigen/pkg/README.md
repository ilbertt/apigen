# @ilbertt/apigen

> WinterTC-compatible REST API handlers from your Postgres schema

apigen writes the CRUD; you write the auth. You choose which relations and columns
to expose and authorize each operation in code — a SQL `USING` / `WITH CHECK`
policy, plus optional hooks. Requests become PostgREST-style queries, compiled to
parameterized SQL and run against a database you pass in.

- **Runtime-agnostic.** `app.handle` is a `(Request) => Promise<Response>` on
  Web-standard globals; mount it into any [WinterTC](https://wintertc.org/) server
  (Bun, Node ≥18, Deno). No server is bundled.
- **You own the connection.** apigen never opens one or takes a connection string —
  you pass a live `db` (postgres.js, Bun.SQL, or an adapter).
- **Zero runtime dependencies.** SQL is built with a vendored copy of
  `sql-template-tag`; request values reach the database only as bound params.

## Install

```sh
bun add @ilbertt/apigen
# codegen (dev only) also needs PGlite:
bun add -d @electric-sql/pglite
```

## Quick start

**1. Write your schema as migrations** (`migrations/*.sql`, applied in filename order):

```sql
-- migrations/001_init.sql
create table orders (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  customer text not null,
  amount numeric(12, 2) not null default 0,
  status text not null default 'pending'
);
```

**2. Generate the typed client:**

```sh
bunx apigen gen --migrations ./migrations --out ./api.gen.ts
```

`api.gen.ts` is a committed file: the `catalog` (relation → column → pgType), row
types, and a catalog-bound `Apigen` and `relation`. Authorization is your code, not
generated.

**3. Write your policies.** A relation is a `.use()`-able module:

```ts
// orders.ts
import { relation } from './api.gen';
import { auth } from './auth'; // your code: (req) => Promise<User | null>

export const orders = relation('orders')
  .select({
    authorization: async (req, { sql }) => {
      const user = await auth(req);
      if (!user) return false; // → 403
      return { policy: sql.using`org_id = ${user.orgId}::uuid` };
    },
  })
  .insert({
    authorization: async (req, { sql }) => {
      const user = await auth(req);
      if (!user) return false;
      return {
        policy: sql.withCheck`org_id = ${user.orgId}::uuid`,
        allowedColumns: ['customer', 'amount', 'status', 'org_id'],
      };
    },
  });
// unregistered verbs (.update / .delete) are denied
```

**4. Mount and serve:**

```ts
import postgres from 'postgres';
import { Apigen } from './api.gen';
import { orders } from './orders';

const app = new Apigen({ db: postgres(process.env.DATABASE_URL!) }).use(orders);

Bun.serve({ port: 3000, fetch: app.handle });
// Node:  a WinterTC http adapter over app.handle
// Deno:  Deno.serve(app.handle)
```

```sh
curl 'http://localhost:3000/orders?status=eq.paid&order=amount.desc&limit=10' \
  -H 'authorization: Bearer …'
```

## Authorization

Each verb takes a config object:

```ts
.select({ authorization?, beforeExecute?, afterExecute? })
```

`authorization` decides who may run the operation and on which rows. Omit it and the
operation is public (`USING true`, every column). When present:

```ts
(req, { sql }) => false | { policy, allowedColumns? }
```

- `req` — the raw request. There is no resolved user; call your own auth helper.
  Memoize it on the `Request` (e.g. a `WeakMap`) if you want it to run once.
- `sql` — the clause builder for this op: `sql.using` on select/update/delete,
  `sql.withCheck` on insert. The wrong one is a type error. `${values}` are bound
  params; the rest of the fragment is trusted SQL, so subqueries and `EXISTS` work.
- `policy` — a `USING` predicate (which rows the op may touch) or `WITH CHECK`
  (which rows a write may produce). On update, `withCheck` defaults to `using`, so a
  write can't move a row out of scope.
- `allowedColumns` — column names, defaulting to all. The visible set for `?select=`
  and filters on reads; the writable set on writes. Any other column is a 403.
- `false` — denies the operation (403). The function may be async.

Reads and deletes filter silently — out-of-scope rows are invisible. Writes reject
rows that fail `WITH CHECK`.

### Hooks

`beforeExecute` and `afterExecute` are optional per-op hooks, each taking one object:

- `beforeExecute({ req, op, relation })` — runs after routing, before the query.
  Returns nothing; use it for logging or metrics. May be async.
- `afterExecute({ req, op, relation, response })` — runs on a successful response and
  returns the `Response` to send, mutated or replaced. It does not see rows.

```ts
import { relation } from './api.gen';

export const products = relation('products').select({
  beforeExecute: ({ op, relation }) => {
    console.log(`Handling ${op} on ${relation}`);
  },
  afterExecute: ({ relation, response }) => {
    response.headers.set('x-apigen-relation', relation);
    return response;
  },
});
```

## Query parameters (PostgREST subset)

`select`, the filters `eq neq gt gte lt lte in is like ilike`, `order`
(`asc`/`desc`, `nullsfirst`/`nullslast`), `limit`, `offset`. Filter values are cast
to the column's catalog type; a value that doesn't fit (text for an `int8`, say) is a
400 and never reaches the database. `int8` and `numeric` come back as strings.

Method → operation: `GET` select, `POST` insert, `PATCH` update, `DELETE` delete.

## Database

Pass a live instance, not a connection string:

```ts
new Apigen({ db: sql });        // postgres.js or Bun.SQL, detected by shape
new Apigen({ db: myAdapter });  // an Adapter from createAdapter()
```

The adapter contract is just execution:

```ts
interface Adapter {
  execute(q: { text: string; values: unknown[] }): Promise<unknown[]>;
  transaction<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>;
}
```

`createAdapter` and the built-in postgres.js/Bun.SQL adapter live in
`@ilbertt/apigen/adapters`. Each request runs in one transaction. The database
speaks TCP, so apigen runs on server runtimes, not edge/Workers.

## CLI

```
apigen gen [--migrations <dir>] [--out <file>] [--module <specifier>]
  -m, --migrations   Directory of *.sql migrations (default: ./migrations)
  -o, --out          Output file (default: ./api.gen.ts)
  -s, --module       Runtime import specifier (default: @ilbertt/apigen)
```

## Not included (yet)

RPC/functions, embeds, OpenAPI generation, divergent `withCheck`, a `pg` adapter,
and SQLite/D1 dialects are out of scope for now.

## License

Unlicense. Bundles a vendored copy of
[`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag) (MIT) — see
`NOTICE`.
