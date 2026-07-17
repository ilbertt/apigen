# with-node

apigen over a small ecommerce schema, served from Node's built-in **`node:http`**
module. apigen ships no server — `api.handle` is a WinterTC `(Request) => Response` —
so `src/index.ts` is the adapter: it builds a web `Request` from each
`IncomingMessage` and writes the web `Response` back onto the `ServerResponse`.
Uses the postgres.js connector (same `src/db.ts` as [`with-postgres`](../with-postgres)).

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
