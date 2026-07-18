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
  org_id uuid not null,
  customer text not null,
  amount numeric(12, 2) not null default 0,
  status text not null default 'pending',
  paid boolean not null default false,
  created_at timestamptz not null default now(),
  note text -- nullable on purpose: exercises NULL semantics (is/isdistinct/negation)
);

create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null,
  org_id uuid not null,
  sku text not null,
  qty integer not null default 1,
  price numeric(12, 2) not null default 0
);
