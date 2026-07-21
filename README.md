# apigen

> WinterTC-compatible REST API handlers from your Postgres schema

A JavaScript library that generates [PostgREST](https://postgrest.org)-compatible REST
handlers from your Postgres schema. You mount them into your own server, pick which tables
and columns to expose, and authorize each operation as ordinary code in your app.

## Motivation

There are two usual ways to put a database behind an HTTP API:

- **Write the endpoints yourself.** Every table needs listing, filtering, pagination, and
  writes, and you're one PR away from a missing filter, an over-exposed column, or code
  that has drifted from the schema.
- **Use a backend-as-a-service.** Supabase, Hasura, and the like generate the API for you,
  until you need something the platform doesn't do, then you're stuck working around it.

apigen is the middle ground. Point the codegen at your Postgres database, pick the tables
to expose, and write one access policy per table. It generates the request handling; the
code lives in your repo and runs on your server.

You get the table-to-API ergonomics of Supabase, as code you own instead of a service you run.

## Comparison

| Solution | apigen | [Supabase](https://supabase.com) | [Hasura](https://hasura.io) | [Convex](https://convex.dev) | [PostgREST](https://postgres.org) | Implement from scratch |
|-|-|-|-|-|-|-|
| Fully extensible | ✅ | ⚠️ only Edge Functions | ❌ | ✅ | ❌ | ✅ |
| Customize access policies | ✅ | ⚠️ only RLS | ⚠️ limited to YAML | ✅ | ⚠️ only RLS | ⚠️ needs extensive tests |
| DB schema is the API | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Self-hostable | ✅ | ⚠️ limited features | ⚠️ limited features | ⚠️ limited features | ✅ | ✅ |

## Quickstart

Install the package:

```bash
npm i @ilbertt/apigen
```

Generate a typed client from your running database:

```bash
npx apigen gen --database-url postgres://user:pw@localhost:5432/app --out src/api.gen.ts
```

> No running database? Generate from SQL migrations instead (needs `@electric-sql/pglite`):
>
> ```bash
> npm i -D @electric-sql/pglite
> npx apigen gen --migrations src/db/migrations --out src/api.gen.ts
> ```

Now expose the tables you want, each with its own policy. The snippets below build up a single file.

**1. Expose a public relation.**

```ts
import { Apigen, relation } from './api.gen';

// A public, read-only catalog — no authorization needed.
const products = relation('products')
  .select({
    beforeExecute: ({ op, relation }) => {
      console.log(`Handling ${op} on ${relation}`)
    },
    afterExecute: ({ relation, response }) => {
      response.headers.set('x-apigen-relation', relation);
      return response;
    },
  });
```

**2. Add access policies to a private relation.**

```ts
// Private: every request is scoped to the caller's org.
const orders = relation('orders')
  .select({
    authorization: async (req, { sql }) => {
      const user = await auth(req); // your own auth helper
      if (!user) return false; // 403
      return { policy: sql.using`org_id = ${user.orgId}::uuid` };
    },
    beforeExecute: () => {
      console.log(`Selecting orders...`)
    },
    afterExecute: () => {
      console.log(`Selected orders!`)
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
// no .update / .delete → those operations return 403
```

**3. Mount and serve.**

```ts
import { db } from './your-db-client';

const app = new Apigen({ db }).use(products).use(orders);

// app.handle is a WinterTC (Request) => Response — mount it into any server
Bun.serve({ fetch: app.handle });
```

**4. Send requests.**

```bash
curl 'http://localhost:3000/products?select=title,price&order=price.desc'

curl -X POST http://localhost:3000/orders -H 'authorization: Bearer ...'
```

Requests are PostgREST-style — the same wire format the Supabase client and PostgREST tooling speak.

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/simple`](./examples/simple) | The core patterns on a single `todos` table — relations, per-verb policies, `allowedColumns`; no joins |
| [`examples/pg-functions`](./examples/pg-functions) | Exposing Postgres functions as `POST /rpc/<name>` — the `func()` factory, coarse authorization, defaulted args |
| [`examples/with-bun`](./examples/with-bun) | The ecommerce schema with Bun's built-in SQL client |
| [`examples/with-postgres`](./examples/with-postgres) | The ecommerce schema with postgres.js |
| [`examples/with-elysia`](./examples/with-elysia) | The ecommerce schema, `app.handle` mounted into an Elysia server |
| [`examples/with-supabase-client`](./examples/with-supabase-client) | The stock `@supabase/supabase-js` client talking to an apigen backend (apigen is PostgREST-compatible) |
| [`examples/with-node`](./examples/with-node) | The ecommerce schema served from Node's built-in `node:http` module — a WinterTC adapter over `app.handle` |
| [`examples/with-express`](./examples/with-express) | The ecommerce schema mounted into an Express app via a Request/Response adapter |
| [`examples/pg-views`](./examples/pg-views) | Exposing Postgres **views** (not tables) as read-only relations — a curated projection + an aggregate |
| [`examples/with-hono`](./examples/with-hono) | The ecommerce schema, `app.handle` mounted into a Hono server |
