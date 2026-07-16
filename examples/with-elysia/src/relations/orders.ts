/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, sql) by design. */

import { relation } from '../api.gen.ts';
import { auth } from '../auth.ts';

// Orders are private to the customer that placed them. Every verb resolves the
// caller first and returns `false` (→ 403) when there's no valid token.
export const orders = relation('orders')
  .select(async (req, sql) => {
    const caller = await auth(req);
    return caller ? { policy: sql.using`customer_id = ${caller.id}::uuid` } : false;
  })
  .insert(async (req, sql) => {
    const caller = await auth(req);
    return caller
      ? {
          policy: sql.withCheck`customer_id = ${caller.id}::uuid`,
          allowedColumns: ['customer_id', 'status', 'total'],
        }
      : false;
  })
  .update(async (req, sql) => {
    const caller = await auth(req);
    return caller
      ? {
          policy: sql.using`customer_id = ${caller.id}::uuid`,
          allowedColumns: ['status', 'total'],
        }
      : false;
  })
  .delete(async (req, sql) => {
    const caller = await auth(req);
    return caller ? { policy: sql.using`customer_id = ${caller.id}::uuid` } : false;
  });
