-- A single table, no foreign keys: the simple example exists to show apigen's
-- design patterns (relation modules, per-verb policies, allowedColumns, mounting)
-- without any join or multi-table machinery. Rows are owned by `owner` (a uuid the
-- caller sends in the x-owner-id header).
create table todos (
  id bigint generated always as identity primary key,
  owner uuid not null,
  title text not null,
  done boolean not null default false,
  priority integer not null default 0,
  notes text
);
