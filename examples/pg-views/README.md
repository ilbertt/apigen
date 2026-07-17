# pg-views

apigen exposes **Postgres views** exactly like tables: a view shows up in the
generated catalog and you `.use()` it the same way — including per-verb authorization
policies and the `beforeExecute` / `afterExecute` hooks. This example keeps the base
`products` table private and exposes two read-only views over it.

- **`in_stock_products`** — a public, curated projection: only in-stock rows, only the
  columns a storefront needs (`sku` and the `in_stock` flag stay private).
- **`category_summary`** — an aggregate, one row per category, **guarded by an
  authorization policy**: a caller may only read the summary for the category in their
  `x-category` header (no header → 403), and the request runs through the hooks.

Only `.select()` is registered on each, so writes are denied (403), and the base
`products` table is never exposed (`GET /products` → 404).

Run `bun start:api`, then:

```sh
# in_stock_products is public
curl 'localhost:3000/in_stock_products?order=price.desc'

# filter + select on a view's columns
curl 'localhost:3000/in_stock_products?category=eq.Cables&select=name,price'

# category_summary is authorized — you only see your own category
curl localhost:3000/category_summary -H 'x-category: Keyboards'

# no x-category header → 403
curl -i localhost:3000/category_summary

# the base table is never exposed
curl -i localhost:3000/products   # 404
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql` loaded.*
