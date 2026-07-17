import { Hono } from 'hono';
import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const api = new Apigen({ db }).use(products).use(orders).use(orderItems);

// apigen ships no server: `api.handle` is a WinterTC (Request) => Response. Hono's
// `.mount` mounts any such handler — here at the root — passing the full method, path,
// and query through unchanged.
const app = new Hono().mount('/', api.handle);

const port = Number(process.env.PORT) || 3000;
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`listening on ${server.url}`);
