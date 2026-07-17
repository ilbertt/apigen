# @ilbertt/apigen

> WinterTC-compatible REST API handlers from your Postgres schema

apigen writes the CRUD; **you write the auth**. For each relation + operation you
declare an RLS-style policy (`USING` / `WITH CHECK`) as a SQL fragment. Requests
become PostgREST-style queries, composed as parameterized SQL and run against a
database instance you pass in.

- **Runtime-agnostic.** `app.handle(req)` is a `(Request) => Promise<Response>`
  built on Web-standard globals — mount it into any [WinterTC](https://wintertc.org/)
  server on Bun, Node ≥18, or Deno. No server is bundled.
- **You own the connection.** apigen never opens a connection or takes a
  connection string — you pass a live `db` (postgres.js, Bun.SQL, or an adapter).
- **Zero runtime dependencies.** SQL is composed with a vendored, trimmed copy of
  `sql-template-tag`; request values only ever reach the database as bound params.

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

**2. Generate the typed client** — introspects your schema into `api.gen.ts`:

```sh
bunx apigen gen --migrations ./migrations --out ./api.gen.ts
```

`api.gen.ts` is a committed file containing the `catalog` (relation → column →
pgType), per-relation row types, and a catalog-bound `Apigen` class and
`relation` factory. Nothing about authorization is generated.

**3. Write your policies** — a relation is a `.use()`-able module:

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
// omitted verbs (.update / .delete) → those operations are denied
```

**4. Mount and serve** — wire `app.handle` into whatever server you run:

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

Each verb takes an operation-config object:

```ts
.select({ authorization?, beforeExecute?, afterExecute? })
```

`authorization` is the same function as before and is now **optional** — omitting
it exposes that op **publicly** (policy `USING true`, all columns). When present it
has the shape:

```ts
(req: Request, ctx: { sql }) => false | { policy; allowedColumns? }
```

- **`req`** — the raw `Request`. The context carries no resolved user; write your own
  auth helper and memoize it on the `Request` (via a `WeakMap`) so it runs once.
- **`ctx`** — a context object; destructure what you need (`(req, { sql }) => …`).
  It exposes `sql` today and is where op-scoped tools will be added over time.
- **`sql`** — an op-appropriate clause builder. `` sql.using`…` `` on
  select/update/delete; `` sql.withCheck`…` `` on insert. The wrong one is a type
  error. Interpolated `${values}` become **bound params**; the predicate is
  trusted author SQL and may use subqueries / `EXISTS` / `IN`.
- **`policy`** — compiles to `USING (…)` (which existing rows the op may touch)
  or `WITH CHECK (…)` (validates the new/modified row). On `update`, `withCheck`
  defaults to `using`, so a row can't be moved out of your scope.
- **`allowedColumns`** — column **names** only (casting types come from the
  catalog). On reads it's the visible whitelist for `?select=` and filters; on
  writes it's the writable whitelist. Omitted → all columns. A request naming any
  other column → **403**.
- Returning **`false`** denies the operation (**403**). The function may be
  `async` — coarse gates can `return false` after calling your services.

Reads and deletes **filter silently** (out-of-scope rows are simply invisible);
writes **reject** rows that fail `WITH CHECK`.

### Hooks

Two optional per-op hooks, each taking a single object arg:

- **`beforeExecute`** — `({ req, op, relation }) => void` (may be `async`). Runs
  once the op is routed, **before** the query. For logging/observability.
- **`afterExecute`** — `({ req, op, relation, response }) => Response`. Runs only on
  a **successful** response and **must return** a `Response` (the same one mutated,
  or a new one). It does **not** receive rows.

```ts
import { relation } from '../api.gen.ts';

export const products = relation('products').select({
  beforeExecute: ({ op, relation }) => {
    void fetch('https://o11y.example/ingest', {
      method: 'POST',
      body: JSON.stringify({ op, relation }),
    }).catch(() => {});
  },
  afterExecute: ({ relation, response }) => {
    response.headers.set('x-apigen-relation', relation);
    return response;
  },
});
```

## Query parameters (PostgREST subset)

`select`, filters `eq neq gt gte lt lte in is like ilike`, `order` (with
`asc`/`desc`, `nullsfirst`/`nullslast`), `limit`, `offset`. Filter values are cast
to the column's catalog type; an invalid value (e.g. text where an `int8` is
expected) is a **400**, never executed as SQL. `int8` / `numeric` are surfaced as
strings.

Method → operation: `GET` → select, `POST` → insert, `PATCH` → update,
`DELETE` → delete.

## Database

Pass a **live** instance — never a connection string:

```ts
new Apigen({ db: sql });        // postgres.js or Bun.SQL — auto-detected by shape
new Apigen({ db: myAdapter });  // an Adapter from createAdapter()
```

The adapter contract is execution-level:

```ts
interface Adapter {
  execute(q: { text: string; values: unknown[] }): Promise<unknown[]>;
  transaction<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>;
}
```

`createAdapter` and the built-in postgres.js/Bun.SQL adapter are available from
`@ilbertt/apigen/adapters`. One transaction runs per request. Because the
database needs TCP, apigen runs on server runtimes (not edge/Workers).

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
