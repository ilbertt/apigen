import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const app = new Apigen({ db }).use(products).use(orders).use(orderItems);

const server = Bun.serve({ port: 3000, fetch: app.handle });
console.log(`listening on ${server.url}`);
