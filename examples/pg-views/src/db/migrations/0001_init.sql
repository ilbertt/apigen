-- The base table. It is deliberately NOT exposed over HTTP (never .use()'d) — only
-- the two views below are. apigen treats a view like any other relation: it shows up
-- in the generated catalog and you .use() it exactly as you would a table.
create table products (
  id bigint generated always as identity primary key,
  sku text not null unique,
  name text not null,
  category text not null,
  price numeric(12, 2) not null default 0,
  in_stock boolean not null default true,
  added_on date not null default current_date
);

-- View 1 — a curated projection: only in-stock rows, and only the columns a
-- storefront needs (sku and the in_stock flag stay private). The API surface is the
-- view's shape, not the table's.
create view in_stock_products as
  select id, name, category, price
  from products
  where in_stock;

-- View 2 — an aggregate, one row per category. Views like this are read-only by
-- nature, which is exactly the read-only relation apigen exposes.
create view category_summary as
  select
    category,
    count(*) as product_count,
    avg(price)::numeric(12, 2) as avg_price
  from products
  group by category;
