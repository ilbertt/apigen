-- Schema for the PostgREST compliance suite. Owned by this folder (not shared with
-- the hermetic unit fixtures) so it can grow the exotic column types each PostgREST
-- feature needs — arrays, ranges, tsvector, jsonb — without disturbing the unit-test
-- snapshots. The catalog apigen runs against is introspected from this live schema in
-- the test's beforeAll, so there is no hand-written catalog to drift out of sync.

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table orders (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs (id),
  customer text not null,
  amount numeric(12, 2) not null default 0,
  status text not null default 'pending',
  paid boolean not null default false,
  created_at timestamptz not null default now(),
  note text, -- nullable on purpose: exercises NULL semantics (is/isdistinct/negation)
  description text not null default '', -- prose for full-text search (fts/plfts/phfts/wfts)
  tags text[] not null default '{}', -- array for containment/overlap (cs/cd/ov)
  span int4range, -- range for range operators (cs/cd/ov/sl/sr/nxr/nxl/adj)
  meta jsonb -- JSON for path selection (meta->>key / meta->key)
);

-- Foreign keys drive resource embedding: order_items→orders (one-to-many) and →orgs.
create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders (id),
  org_id uuid not null references orgs (id),
  sku text not null,
  qty integer not null default 1,
  price numeric(12, 2) not null default 0
);

-- Settable natural PK (unlike orders' generated-always id) so upsert/PUT can target it.
create table products (
  sku text primary key,
  name text not null,
  price numeric(12, 2) not null default 0,
  stock integer not null default 0
);

-- A second exposed schema, selected per-request via Accept-Profile (reads) /
-- Content-Profile (writes). `widgets` lives ONLY here, so a request without the
-- profile header can't reach it — that is what proves schema routing works.
create schema inventory;

create table inventory.widgets (
  id integer primary key,
  label text not null,
  qty integer not null default 0
);
