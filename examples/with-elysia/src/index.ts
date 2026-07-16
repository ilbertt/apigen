import { Elysia } from 'elysia';
import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const api = new Apigen({ db }).use(products).use(orders).use(orderItems);

// apigen ships no server: `api.handle` is a WinterTC (Request) => Response. Elysia's
// single-argument `.mount` mounts it at the root and passes the full method, path,
// and query through unchanged.
const app = new Elysia().mount(api.handle).listen(3000);

console.log(`listening on ${app.server?.url}`);
