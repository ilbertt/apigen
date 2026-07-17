import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { categorySummary } from './relations/category-summary.ts';
import { inStockProducts } from './relations/in-stock-products.ts';

// Only the views are exposed. The base `products` table is never .use()'d, so
// GET /products is a 404 — callers see the curated views, not the raw table.
const app = new Apigen({ db }).use(inStockProducts).use(categorySummary);

const port = Number(process.env.PORT) || 3000;
const server = Bun.serve({ port, fetch: app.handle });
console.log(`listening on ${server.url}`);
