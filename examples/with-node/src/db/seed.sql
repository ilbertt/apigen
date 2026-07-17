-- Two customers with fixed ids + tokens so the README curls are copy-pasteable.
insert into customers (id, email, api_token) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ada@example.com', 'tok_ada'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'grace@example.com', 'tok_grace');

insert into products (sku, name, price, in_stock, attributes) values
  ('KEEB-1', 'Mechanical Keyboard', 129.00, true, '{"switches": "brown"}'),
  ('CABL-1', 'USB-C Cable', 9.50, true, '{"length_m": 2}'),
  ('STND-1', 'Laptop Stand', 45.00, false, '{}');

-- Identity ids start at 1, so orders get 1 (Ada) and 2 (Grace).
insert into orders (customer_id, status, total) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'paid', 138.50),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pending', 45.00);

insert into order_items (order_id, product_id, quantity, unit_price) values
  (1, 1, 1, 129.00),
  (1, 2, 1, 9.50),
  (2, 3, 1, 45.00);
