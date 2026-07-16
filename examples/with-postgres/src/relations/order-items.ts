/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, sql) by design. */

import { relation } from '../api.gen.ts';
import { auth } from '../auth.ts';

// order_items has no customer_id of its own — it belongs to a customer *through*
// its order. Each policy reaches the owner with an EXISTS subquery over `orders`:
// authorization that follows a foreign key.
export const orderItems = relation('order_items')
  .select(async (req, sql) => {
    const caller = await auth(req);
    return caller
      ? {
          policy: sql.using`exists (
            select 1 from orders o
            where o.id = order_items.order_id and o.customer_id = ${caller.id}::uuid
          )`,
        }
      : false;
  })
  .insert(async (req, sql) => {
    const caller = await auth(req);
    // In WITH CHECK on insert, `order_id` refers to the row being inserted.
    return caller
      ? {
          policy: sql.withCheck`exists (
            select 1 from orders o
            where o.id = order_id and o.customer_id = ${caller.id}::uuid
          )`,
          allowedColumns: ['order_id', 'product_id', 'quantity', 'unit_price'],
        }
      : false;
  })
  .update(async (req, sql) => {
    const caller = await auth(req);
    return caller
      ? {
          policy: sql.using`exists (
            select 1 from orders o
            where o.id = order_items.order_id and o.customer_id = ${caller.id}::uuid
          )`,
          allowedColumns: ['quantity', 'unit_price'],
        }
      : false;
  })
  .delete(async (req, sql) => {
    const caller = await auth(req);
    return caller
      ? {
          policy: sql.using`exists (
            select 1 from orders o
            where o.id = order_items.order_id and o.customer_id = ${caller.id}::uuid
          )`,
        }
      : false;
  });
