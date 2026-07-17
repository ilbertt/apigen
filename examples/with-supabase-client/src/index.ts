import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const api = new Apigen({ db }).use(products).use(orders).use(orderItems);

// supabase-js is a PostgREST client, and apigen speaks PostgREST — so the stock
// client talks to apigen directly. supabase-js sends every request to
// `${url}/rest/v1/<table>`; apigen routes from the root, so strip that mount prefix
// before handing the request over. It also sends `Authorization: Bearer <anon key>`,
// which is exactly the shape auth() reads (see src/client.ts).
const REST_PREFIX = '/rest/v1';

function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith(REST_PREFIX)) {
    url.pathname = url.pathname.slice(REST_PREFIX.length) || '/';
    return api.handle(new Request(url.href, req));
  }
  return api.handle(req);
}

const port = Number(process.env.PORT) || 3000;
const server = Bun.serve({ port, fetch: handle });
console.log(`listening on ${server.url}`);
