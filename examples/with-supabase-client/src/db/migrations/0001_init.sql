-- customers is the caller identity. It holds api tokens and is NEVER exposed over
-- HTTP (never .use()'d) — auth() reads it server-side to resolve a bearer token.
create table customers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  api_token text not null unique,
  created_at timestamptz not null default now()
);

-- products is a public, read-only catalog: the relation registers .select only,
-- so writes are denied (403).
create table products (
  id bigint generated always as identity primary key,
  sku text not null unique,
  name text not null,
  price numeric(12, 2) not null default 0,
  in_stock boolean not null default true,
  attributes jsonb not null default '{}',
  added_on date not null default current_date
);

-- orders are private to the customer that placed them (row-scoped policy).
create table orders (
  id bigint generated always as identity primary key,
  customer_id uuid not null references customers(id),
  status text not null default 'pending',
  total numeric(12, 2) not null default 0,
  placed_at timestamptz not null default now()
);

-- order_items are scoped through their owning order via an EXISTS subquery — the
-- "authorization that follows a foreign key" demonstration.
create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  product_id bigint not null references products(id),
  quantity integer not null default 1,
  unit_price numeric(12, 2) not null default 0
);
