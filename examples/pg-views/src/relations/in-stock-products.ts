import { relation } from '../api.gen.ts';

// A curated view exposed read-only: no `authorization` → public. Because only
// .select() is registered, every write verb is denied (403) — which also matches the
// database, where this view isn't updatable.
export const inStockProducts = relation('in_stock_products').select({});
