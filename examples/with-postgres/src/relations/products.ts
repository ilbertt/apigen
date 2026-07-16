/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, sql) by design. */

import { relation } from '../api.gen.ts';

// A public, read-only catalog: no auth, the policy is simply `true`. Only .select
// is registered, so POST/PATCH/DELETE on /products are denied (403).
export const products = relation('products').select((_req, sql) => ({
  policy: sql.using`true`,
}));
