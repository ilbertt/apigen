# apigen

> WinterTC-compatible REST API handlers from your Postgres schema

A JS library that generates [PostgREST](https://postgrest.org) endpoints for your HTTP server,
while giving you full control over the policies for the tables.

## Motivation

When creating an API, you either ask your AI agent to implement it in your codebase
or use backend-as-a-service that takes care of exposing your tables to the web.

The problem is that, in the first case, you are always one PR away from a missing filter param,
a missing exposed column, etc. while in the second case, you are always one container away from the full set
of features you need on your backend.

What if you could solve both problems at once?

You own the code, while the repetitive boring parts are taken care of. All you have to do is point the codegen
to your Postgres schema, pick the tables you want to expose and define your security policies.

Think of it as if you could generate a Supabase "clone" in your codebase, without having to maintain it.

## Comparison

| Solution | Fully extensible | Customize access policies | Self-hostable |
|-|-|-|-|
| apigen | ✅ | ✅ | ✅ |
| Supabase | ⚠️ only Edge Functions | ⚠️ only RLS | ⚠️ limited features |
| Hasura | ❌ | ⚠️ limited to YAML | ⚠️ limited features |
| PostgREST | ❌ | ⚠️ only RLS | ✅ |
| Implement from scratch | ✅ | ⚠️ needs extensive tests | ✅ |

## Quickstart

Install the package:

```bash
npm i @ilbertt/apigen
# Peer dependency, needed for codegen only
npm i -D @electric-sql/pglite
```

Create your db migrations in plain SQL:

```sql
CREATE TABLE orders ...;

CREATE TABLE products ...;
```

Run the codegen:

```bash
npx apigen gen --migrations src/db/migrations --out src/api.gen.ts
```

Expose your table via PostgREST-compatible endpoints:

```ts
import postgres from 'postgres';
import { Apigen, relation } from './api.gen';

const db = postgres("pg://...");

// Type-safe table names from your migrations
const orders = relation('orders')
  .select(() => {
    return { allowedColumns: ['id', 'created_at'] };
  })
  .insert(async (req, { sql }) => {
    const user = await auth(req);
    if (!user) {
      return false;  // returns 403
    }
    return { policy: sql.using`org_id = ${user.orgId}::uuid` };
  })
  .delete(() => false);

const products = relation('products')
  .select(() => {
    return { allowedColumns: ['id', 'title', 'description', 'price'] };
  });

const app = new Apigen({ db })
  .use(orders)
  .use(products);

// WinterTC-compatible handler
Bun.serve({ fetch: app.handle });
```

Send requests to your API:

```bash
# PostgREST-compatible endpoints
curl 'http://localhost:3000/products?select=name,price&order=price.desc'

curl http://localhost:3000/orders -H 'authorization: Bearer ...'
```

## Examples

| Example | Stack | What it shows |
| --- | --- | --- |
| [`examples/simple`](./examples/simple) | Bun.SQL · Bun.serve | The core patterns on a single `todos` table — relations, per-verb policies, `allowedColumns`; no joins |
| [`examples/with-bun`](./examples/with-bun) | Bun.SQL · Bun.serve | The ecommerce schema with Bun's built-in SQL client |
| [`examples/with-postgres`](./examples/with-postgres) | postgres.js · Bun.serve | The ecommerce schema with postgres.js |
| [`examples/with-elysia`](./examples/with-elysia) | Bun.SQL · Elysia | The ecommerce schema, `app.handle` mounted into an Elysia server |
