import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const api = new Apigen({ db }).use(products).use(orders).use(orderItems);

// apigen ships no server: `api.handle` is a WinterTC (Request) => Response. Express
// speaks its own req/res objects, so this middleware bridges them — build a web
// Request from the express request, hand it to apigen, then write the web Response
// back onto the express response. No route table: apigen owns routing from the path.

function readBody(req: ExpressRequest): Promise<Buffer> {
  // biome-ignore lint/complexity/useMaxParams: Promise executor signature is fixed by the language.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req: ExpressRequest): Promise<Request> {
  const url = `${req.protocol}://${req.headers.host ?? 'localhost'}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value ?? '']) {
      headers.append(key, item);
    }
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const raw = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method: req.method, headers, body: raw?.length ? raw : undefined });
}

async function sendWebResponse({
  res,
  response,
}: {
  res: ExpressResponse;
  response: Response;
}): Promise<void> {
  res.status(response.status);
  for (const [key, value] of response.headers) {
    res.setHeader(key, value);
  }
  res.send(Buffer.from(await response.arrayBuffer()));
}

const app = express();
app.disable('x-powered-by');

// biome-ignore lint/complexity/useMaxParams: express middleware signature is (req, res).
app.use(async (req, res) => {
  const response = await api.handle(await toWebRequest(req));
  await sendWebResponse({ res, response });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`listening on http://localhost:${port}`));
