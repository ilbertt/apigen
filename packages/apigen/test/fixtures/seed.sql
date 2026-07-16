insert into orgs (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex');

insert into orders (org_id, customer, amount, status, paid) values
  ('11111111-1111-1111-1111-111111111111', 'Alice', 100.00, 'paid', true),
  ('11111111-1111-1111-1111-111111111111', 'Bob', 50.50, 'pending', false),
  ('22222222-2222-2222-2222-222222222222', 'Carol', 999.99, 'paid', true);

insert into order_items (order_id, org_id, sku, qty, price) values
  (1, '11111111-1111-1111-1111-111111111111', 'WIDGET', 2, 25.00),
  (1, '11111111-1111-1111-1111-111111111111', 'GADGET', 1, 50.00),
  (3, '22222222-2222-2222-2222-222222222222', 'GIZMO', 5, 199.99);
