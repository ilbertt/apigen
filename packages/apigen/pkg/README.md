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
```

## Quick start

**1. Generate the typed client** — point apigen at your running database:

```sh
bunx apigen gen --database-url postgres://user:pw@localhost:5432/app --out ./api.gen.ts
```

> No running database? Generate from SQL migrations instead (needs the
> `@electric-sql/pglite` dev dependency):
>
> ```sh
> bun add -d @electric-sql/pglite
> bunx apigen gen --migrations ./migrations --out ./api.gen.ts
> ```

`api.gen.ts` is a committed file: the `catalog` (relation → column → pgType), row
types, and a catalog-bound `Apigen` and `relation`. Authorization is your code, not
generated.

**2. Write your policies.** A relation is a `.use()`-able module:

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

**3. Mount and serve:**

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

`select` (with `alias:col` renaming and `col::type` casting), the filters
`eq neq gt gte lt lte in is isdistinct like ilike match imatch`,
full-text `fts plfts phfts wfts` (with an optional `(config)`, e.g.
`description=fts(english).red`), and array/range `cs cd ov sl sr nxr nxl adj` — each
optionally negated with a `not.` prefix, e.g. `customer=not.eq.Alice`, and the
comparison/pattern operators also take an `(any)`/`(all)` quantifier over a `{…}` list,
e.g. `id=eq(any).{1,2,3}`. Conditions combine with the logical operators `and` / `or`
(nestable, `not.`-negatable), e.g. `or=(status.eq.paid,amount.gt.100)`. Plus `order`
(`asc`/`desc`, `nullsfirst`/`nullslast`), `limit`, `offset`. Filter values are cast to
the column's catalog type; a value that doesn't fit (text for an `int8`, say) is a 400
and never reaches the database.

Method → operation: `GET` select, `POST` insert, `PATCH` update, `DELETE` delete.

## Responses

Responses match PostgREST byte-for-byte over the supported surface — the JSON is
rendered by Postgres itself, so `numeric` keeps its scale, `int8` comes back as a
number, and `timestamptz` as ISO-8601.

- **Reads** return a JSON array plus a `Content-Range` header (`0-9/*`). `Prefer:
  count=exact` fills in the total (`0-9/42`) and answers `206` when the page is partial.
  Paginate with `limit`/`offset` or a `Range: 0-9` header (`limit`/`offset` win if both).
- **Writes** default to `Prefer: return=minimal`: `POST` → `201` empty, `PATCH`/`DELETE`
  → `204` empty. Send `Prefer: return=representation` to get the affected rows back.
- **Singular**: `Accept: application/vnd.pgrst.object+json` returns a lone object, or
  `406` (`PGRST116`) when the result isn't exactly one row.
- **Errors** use PostgREST's envelope, `{ code, details, hint, message }`, passing the
  Postgres `SQLSTATE` through on database errors.

## Functions

Expose a Postgres function as an RPC endpoint with `func()`. A call is
`POST /rpc/<name>` with a JSON body of arguments; apigen binds each argument by name
and casts it to the argument's type, so order is irrelevant and omitted arguments fall
back to the function's defaults.

```ts
import { func } from './api.gen';

// public — `.execute({})` opts the function in; an unregistered function denies calls
export const greet = func('greet').execute({});

// gated — a function's authorization is a coarse boolean: may this caller run it?
export const publish = func('publish_article').execute({
  authorization: (req) => isAdmin(req), // false → 403; may be async
});
```

```sh
curl -X POST http://localhost:3000/rpc/greet \
  -H 'content-type: application/json' -d '{"name":"World"}'
```

A function has no rows or columns to scope, so its authorization is a coarse gate
rather than a `USING`/`WITH CHECK` policy — row-level rules belong on relations (or
inside the function's own SQL). The `beforeExecute`/`afterExecute` hooks work the
same, with a `{ req, functionName }` context. The result of `select * from fn(...)` is
returned as rows, so scalar, composite, and set-returning functions all come back as a
JSON array. Functions are called with `POST` only.

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

`apigen gen` writes `api.gen.ts` from either a running Postgres (`--database-url`)
or SQL migrations (`--migrations`, which needs `@electric-sql/pglite`). Run it with
`--help` for the current flags:

```sh
bunx apigen gen --help
```

## Not included (yet)

CSV and other content types, embeds, OpenAPI generation, divergent `withCheck`, a `pg`
adapter, and SQLite/D1 dialects are out of scope for now. apigen also enforces `allowedColumns` up front (a
`403`) instead of deferring to Postgres, so an unknown or forbidden column is rejected
before the query runs.

## License

Unlicense. Bundles a vendored copy of
[`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag) (MIT) — see
`NOTICE`.
