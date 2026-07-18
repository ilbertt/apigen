-- Deterministic seed for the PostgREST compliance suite. PostgREST and apigen hit the
-- SAME database and each case reseeds before BOTH sides, so this has to be fully
-- deterministic and re-runnable: created_at is pinned (not now()) and identity is
-- restarted so inserted rows get stable ids. That is why it can't just reuse
-- fixtures/seed.sql.
truncate orgs, orders, order_items, products, inventory.widgets restart identity cascade;

insert into orgs (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex');

insert into orders (org_id, customer, amount, status, paid, created_at, note, description, tags, span, meta) values
  ('11111111-1111-1111-1111-111111111111', 'Alice', 100.00, 'paid', true, '2024-01-01T00:00:00Z', 'vip', 'fast red bicycle', '{vip,priority}', '[1,10)', '{"tier":"gold","age":30}'),
  ('11111111-1111-1111-1111-111111111111', 'Bob', 50.50, 'pending', false, '2024-01-02T00:00:00Z', null, 'slow blue car', '{}', '[5,15)', '{"tier":"silver","age":25}'),
  ('22222222-2222-2222-2222-222222222222', 'Carol', 999.99, 'paid', true, '2024-01-03T00:00:00Z', 'vip', 'shiny red car', '{vip}', '[20,30)', '{"tier":"gold","age":40}');

insert into order_items (order_id, org_id, sku, qty, price) values
  (1, '11111111-1111-1111-1111-111111111111', 'WIDGET', 2, 25.00),
  (1, '11111111-1111-1111-1111-111111111111', 'GADGET', 1, 50.00),
  (3, '22222222-2222-2222-2222-222222222222', 'GIZMO', 5, 199.99);

insert into products (sku, name, price, stock) values
  ('WIDGET', 'Widget', 25.00, 100),
  ('GADGET', 'Gadget', 50.00, 40);

-- In the second schema, reached only via Accept-Profile/Content-Profile: inventory.
insert into inventory.widgets (id, label, qty) values
  (1, 'Gadget', 7),
  (2, 'Gizmo', 3);
