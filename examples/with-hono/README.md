# with-hono

apigen over a small ecommerce schema, mounted into a **Hono** server
(`new Hono().mount('/', api.handle)`) with the Bun.SQL connector.

Run `bun start:api`, then:

```sh
# products: public, read-only
curl 'localhost:3000/products?select=name,price&order=price.desc'

# orders: private to your token
curl localhost:3000/orders -H 'authorization: Bearer tok_ada'

# order_items: scoped through their order
curl localhost:3000/order_items -H 'authorization: Bearer tok_ada'

# create an order
curl -X POST localhost:3000/orders -H 'authorization: Bearer tok_ada' \
  -H 'content-type: application/json' \
  -d '{"customer_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","total":10}'

# customers is never exposed
curl -i localhost:3000/customers -H 'authorization: Bearer tok_ada'   # 404
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql` loaded.*
