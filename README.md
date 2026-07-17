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

apigen is the middle ground. Point the codegen at your Postgres migrations, pick the tables
to expose, and write one access policy per table. It generates the request handling; the
code lives in your repo and runs on your server.

You get the table-to-API ergonomics of Supabase, as code you own instead of a service you run.

## Comparison

| Solution | Fully extensible | Customize access policies | DB schema is the API | Self-hostable |
|-|-|-|-|-|
| apigen | ✅ | ✅ | ✅ | ✅ |
| [Supabase](https://supabase.com) | ⚠️ only Edge Functions | ⚠️ only RLS | ✅ | ⚠️ limited features |
| [Hasura](https://hasura.io) | ❌ | ⚠️ limited to YAML | ✅ | ⚠️ limited features |
| [Convex](https://convex.dev) | ✅ | ✅ | ❌ | ⚠️ limited features |
| [PostgREST](https://postgres.org) | ❌ | ⚠️ only RLS | ✅ | ✅ |
| Implement from scratch | ✅ | ⚠️ needs extensive tests | ❌ | ✅ |

## Quickstart

Install the package:

```bash
npm i @ilbertt/apigen
# Peer dependency, needed for codegen only
npm i -D @electric-sql/pglite
```

Write your schema as plain SQL migrations:

```sql
CREATE TABLE products ...;

CREATE TABLE orders ...;
```

Generate a typed client from the migrations:

```bash
npx apigen gen --migrations src/db/migrations --out src/api.gen.ts
```

Expose the tables you want, each with its own policy:

```ts
import postgres from 'postgres';
import { Apigen, relation } from './api.gen';

const db = postgres('postgres://...');

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

const app = new Apigen({ db }).use(products).use(orders);

// app.handle is a WinterTC (Request) => Response
Bun.serve({ fetch: app.handle });
```

Send PostgREST-style requests:

```bash
curl 'http://localhost:3000/products?select=title,price&order=price.desc'

curl -X POST http://localhost:3000/orders -H 'authorization: Bearer ...'
```

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/simple`](./examples/simple) | The core patterns on a single `todos` table — relations, per-verb policies, `allowedColumns`; no joins |
| [`examples/with-bun`](./examples/with-bun) | The ecommerce schema with Bun's built-in SQL client |
| [`examples/with-postgres`](./examples/with-postgres) | The ecommerce schema with postgres.js |
| [`examples/with-elysia`](./examples/with-elysia) | The ecommerce schema, `app.handle` mounted into an Elysia server |
| [`examples/with-supabase-client`](./examples/with-supabase-client) | The stock `@supabase/supabase-js` client talking to an apigen backend (apigen is PostgREST-compatible) |
| [`examples/with-node`](./examples/with-node) | The ecommerce schema served from Node's built-in `node:http` module — a WinterTC adapter over `app.handle` |
| [`examples/with-express`](./examples/with-express) | The ecommerce schema mounted into an Express app via a Request/Response adapter |
