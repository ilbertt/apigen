/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { relation } from '../api.gen.ts';

export const products = relation('products').select((_req, { sql }) => ({
  policy: sql.using`true`,
}));
