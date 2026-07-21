# @ilbertt/apigen

> WinterTC-compatible REST API handlers from your Postgres schema

apigen generates [PostgREST](https://postgrest.org)-compatible REST handlers from your
Postgres schema. You pick which relations and columns to expose, authorize each operation
as ordinary code, and mount the result into your own server. apigen writes the CRUD; you
write the auth.

- **Runtime-agnostic.** `app.handle` is a Web-standard `(Request) => Promise<Response>` —
  mount it into any [WinterTC](https://wintertc.org/) server (Bun, Node ≥18, Deno). No
  server is bundled.
- **You own the connection.** apigen never opens one; you pass a live `db` (postgres.js,
  Bun.SQL, or an adapter).
- **Zero runtime dependencies.** Request values reach the database only as bound params.

## Install

```sh
bun add @ilbertt/apigen
```

## Quick start

Generate a typed client from your running database:

```sh
bunx apigen gen --database-url postgres://user:pw@localhost:5432/app --out ./api.gen.ts
```

> No running database? Generate from SQL migrations instead (needs `@electric-sql/pglite`):
>
> ```sh
> bun add -d @electric-sql/pglite
> bunx apigen gen --migrations ./migrations --out ./api.gen.ts
> ```

`api.gen.ts` is a committed file — the catalog (relation → column → pgType), row types, and
a catalog-bound `Apigen` and `relation`. Authorization is your code, not generated. The
snippets below build up a single file.

**1. Expose a public relation.**

```ts
import { Apigen, relation } from './api.gen';

// A public, read-only catalog — no authorization needed.
const products = relation('products').select({});
```

A relation with no `authorization` is public. Optional `beforeExecute` / `afterExecute`
hooks (see [Authorization](#authorization)) let you observe or decorate each request.

**2. Add access policies to a private relation.**

```ts
import { auth } from './auth'; // your code: (req) => Promise<User | null>

const orders = relation('orders')
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
        allowedColumns: ['customer', 'amount', 'org_id'],
      };
    },
  });
// unregistered verbs (.update / .delete) are denied
```

Each operation is authorized on its own: return `false` for a 403, or a SQL policy that
scopes the query to the caller. `allowedColumns` bounds what a read exposes and a write can
touch.

**3. Mount and serve.**

```ts
import postgres from 'postgres';

const app = new Apigen({ db: postgres(process.env.DATABASE_URL!) })
  .use(products)
  .use(orders);

Bun.serve({ port: 3000, fetch: app.handle }); // Deno.serve(app.handle) / a Node adapter
```

`app.handle` is a WinterTC `(Request) => Response`, so it drops into any compatible server.

**4. Send requests.**

```sh
curl 'http://localhost:3000/orders?status=eq.paid&order=amount.desc&limit=10' \
  -H 'authorization: Bearer …'
```

Requests are PostgREST-style — the same wire format the Supabase client and PostgREST
tooling speak.

## Authorization

Each verb takes a config object — an optional `authorization` plus optional
`beforeExecute` / `afterExecute` hooks. `authorization` is:

```ts
(req, { sql }) => false | { policy, allowedColumns? }
```

- Omit it and the operation is public (`USING true`, every column).
- `sql` builds the clause for this op — `sql.using` on select/update/delete, `sql.withCheck`
  on insert (the wrong one is a type error). `${values}` are bound params; the rest is
  trusted SQL, so subqueries and `EXISTS` work.
- `policy` is a `USING` predicate (which rows the op may touch) or `WITH CHECK` (which rows a
  write may produce).
- `allowedColumns` bounds the visible set on reads and the writable set on writes; any other
  column is a 403.
- `false` denies the operation. Reads and deletes filter silently; writes reject rows that
  fail `WITH CHECK`.

`beforeExecute({ req, op, relation })` runs before the query (logging/metrics);
`afterExecute({ req, op, relation, response })` returns the `Response` to send. Neither sees
rows.

## Queries and responses

Requests are PostgREST-style and compile to parameterized SQL:

- **`select`** with renaming, casts, JSON paths, and aggregates; **filters** (`eq`, `in`,
  `like`, `fts`, array/range ops, …) negatable with `not.` and combinable with `and` / `or`;
  plus `order`, `limit`, `offset`. Filter values are cast to the column's type — a bad value
  is a 400 that never reaches the database.
- **Resource embedding** over foreign keys: `select=*,order_items(*)` nests a related
  relation, whose own authorization applies.
- **Methods → operations:** `GET` select, `POST` insert, `PUT` upsert, `PATCH` update,
  `DELETE` delete.
- **Responses match PostgREST byte-for-byte** — the JSON is rendered by Postgres. Reads
  return an array plus a `Content-Range` header; `Prefer: count=exact` adds the total. Writes
  default to `return=minimal`; `Prefer: return=representation` returns the rows. `Accept:
  text/csv` and singular `application/vnd.pgrst.object+json` are supported. Errors use
  PostgREST's `{ code, details, hint, message }` envelope.

See the [examples](https://github.com/ilbertt/apigen/tree/main/examples) for runnable setups
covering each of these.

## Functions

Expose a Postgres function as `POST /rpc/<name>` with `func()`. Arguments are bound by name
and cast to their types, so order is irrelevant and omitted args fall back to the function's
defaults:

```ts
import { func } from './api.gen';

export const greet = func('greet').execute({}); // public
export const publish = func('publish_article').execute({
  authorization: (req) => isAdmin(req), // coarse gate: false → 403
});
```

A function's authorization is a coarse boolean — row-level rules belong on relations. The
`beforeExecute` / `afterExecute` hooks work the same, with a `{ req, functionName }` context.

## Database

Pass a live instance, not a connection string:

```ts
new Apigen({ db: sql });        // postgres.js or Bun.SQL, detected by shape
new Apigen({ db: myAdapter });  // an Adapter from createAdapter()
```

`createAdapter` and the built-in postgres.js/Bun.SQL adapter live in
`@ilbertt/apigen/adapters`. Each request runs in one transaction. The database speaks TCP,
so apigen runs on server runtimes, not edge/Workers.

## More

- **Multiple schemas** — pass `schemas` and mount with `relation(name, { schema })`; clients
  pick a schema per request with `Accept-Profile` (reads) / `Content-Profile` (writes).
- **OpenAPI** — pass the `openapi` option (even `{}`) to serve a Swagger 2.0 document at
  `GET /openapi`.
- **CLI** — `apigen gen` writes `api.gen.ts` from a running database or SQL migrations. Run
  `bunx apigen gen --help` for the flags.

## License

Unlicense. Bundles a vendored copy of
[`sql-template-tag`](https://github.com/blakeembrey/sql-template-tag) (MIT) — see `NOTICE`.
