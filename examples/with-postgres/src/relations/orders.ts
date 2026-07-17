/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { relation } from '../api.gen.ts';
import { auth } from '../auth.ts';

export const orders = relation('orders')
  .select(async (req, { sql }) => {
    const caller = await auth(req);
    if (!caller) {
      return false;
    }
    return { policy: sql.using`customer_id = ${caller.id}::uuid` };
  })
  .insert(async (req, { sql }) => {
    const caller = await auth(req);
    if (!caller) {
      return false;
    }
    return {
      policy: sql.withCheck`customer_id = ${caller.id}::uuid`,
      allowedColumns: ['customer_id', 'status', 'total'],
    };
  })
  .update(async (req, { sql }) => {
    const caller = await auth(req);
    if (!caller) {
      return false;
    }
    return {
      policy: sql.using`customer_id = ${caller.id}::uuid`,
      allowedColumns: ['status', 'total'],
    };
  })
  .delete(async (req, { sql }) => {
    const caller = await auth(req);
    if (!caller) {
      return false;
    }
    return { policy: sql.using`customer_id = ${caller.id}::uuid` };
  });
