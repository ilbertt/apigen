create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table orders (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  customer text not null,
  amount numeric(12, 2) not null default 0,
  status text not null default 'pending',
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null,
  org_id uuid not null,
  sku text not null,
  qty integer not null default 1,
  price numeric(12, 2) not null default 0
);
