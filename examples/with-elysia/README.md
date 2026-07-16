# with-elysia

[`@ilbertt/apigen`](../../packages/apigen/pkg/README.md) mounted into an
[Elysia](https://elysiajs.com) app (`new Elysia().mount(api.handle)`), using the **Bun.SQL**
connector, over a small ecommerce schema. apigen ships no server — `api.handle` is a WinterTC
`(Request) => Response` you mount into any framework.

Run `bun start:api` (deps come from `bun install` at the repo root). It connects to a Postgres
at `postgres://postgres:postgres@localhost:5432/apigen` — hard-coded in `src/db.ts` — with
`src/db/migrations/0001_init.sql` and `src/db/seed.sql` loaded. Then:

```sh
# products — a public, read-only catalog (no auth)
curl 'localhost:3000/products?select=sku,name,price&order=price.desc'

# your orders — scoped to your token; Grace never sees Ada's rows
curl localhost:3000/orders -H 'authorization: Bearer tok_ada'
curl localhost:3000/orders -H 'authorization: Bearer tok_grace'

# order_items — scoped through their order (a foreign-key subquery)
curl localhost:3000/order_items -H 'authorization: Bearer tok_ada'

# place an order — WITH CHECK enforces customer_id is yours
curl -X POST localhost:3000/orders -H 'authorization: Bearer tok_ada' \
  -H 'content-type: application/json' \
  -d '{"customer_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","status":"pending","total":10}'

# no token → 403
curl -i localhost:3000/orders

# writing to the read-only catalog → 403 (only .select is registered)
curl -i -X POST localhost:3000/products -H 'content-type: application/json' -d '{"sku":"X","name":"Y"}'

# customers is never exposed → 404 (auth() reads it server-side)
curl -i localhost:3000/customers -H 'authorization: Bearer tok_ada'
```
