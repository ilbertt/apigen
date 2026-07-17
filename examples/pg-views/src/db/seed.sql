-- Six products across three categories; two are out of stock. The in_stock_products
-- view therefore shows four rows, while category_summary aggregates all six.
insert into products (sku, name, category, price, in_stock) values
  ('KEEB-1', 'Mechanical Keyboard', 'Keyboards', 129.00, true),
  ('KEEB-2', 'Low-profile Keyboard', 'Keyboards', 99.00, false),
  ('CABL-1', 'USB-C Cable', 'Cables', 9.50, true),
  ('CABL-2', 'HDMI Cable', 'Cables', 12.00, true),
  ('STND-1', 'Laptop Stand', 'Stands', 45.00, true),
  ('STND-2', 'Monitor Arm', 'Stands', 89.00, false);
