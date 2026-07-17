/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { relation } from '../api.gen.ts';

// Authorization works on a view exactly as on a table: the USING policy filters the
// view's rows. Here a caller may only read the summary for the category named in their
// `x-category` header — no header is a 403 — and the lifecycle hooks run alongside it.
export const categorySummary = relation('category_summary').select({
  authorization: (req, { sql }) => {
    const category = req.headers.get('x-category');
    if (!category) {
      return false;
    }
    return { policy: sql.using`category = ${category}` };
  },
  beforeExecute: ({ op, relation }) => {
    console.log(`Handling ${op} on ${relation}`);
  },
  afterExecute: ({ relation, response }) => {
    response.headers.set('x-apigen-relation', relation);
    return response;
  },
});
