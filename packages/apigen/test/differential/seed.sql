-- Deterministic seed for the differential harness. PostgREST and apigen hit the
-- SAME database and each case reseeds before BOTH sides, so this has to be fully
-- deterministic and re-runnable: created_at is pinned (not now()) and identity is
-- restarted so inserted rows get stable ids. That is why it can't just reuse
-- fixtures/seed.sql.
truncate orgs, orders, order_items restart identity cascade;

insert into orgs (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex');

insert into orders (org_id, customer, amount, status, paid, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'Alice', 100.00, 'paid', true, '2024-01-01T00:00:00Z'),
  ('11111111-1111-1111-1111-111111111111', 'Bob', 50.50, 'pending', false, '2024-01-02T00:00:00Z'),
  ('22222222-2222-2222-2222-222222222222', 'Carol', 999.99, 'paid', true, '2024-01-03T00:00:00Z');

insert into order_items (order_id, org_id, sku, qty, price) values
  (1, '11111111-1111-1111-1111-111111111111', 'WIDGET', 2, 25.00),
  (1, '11111111-1111-1111-1111-111111111111', 'GADGET', 1, 50.00),
  (3, '22222222-2222-2222-2222-222222222222', 'GIZMO', 5, 199.99);
