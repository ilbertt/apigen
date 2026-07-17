import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Apigen } from './api.gen.ts';
import { db } from './db.ts';
import { orderItems } from './relations/order-items.ts';
import { orders } from './relations/orders.ts';
import { products } from './relations/products.ts';

// `customers` is deliberately NOT .use()'d — it holds api tokens and is only read
// by auth() server-side, so GET /customers is a 404.
const api = new Apigen({ db }).use(products).use(orders).use(orderItems);

// apigen ships no server: `api.handle` is a WinterTC (Request) => Response. Node's
// `http` module speaks IncomingMessage/ServerResponse instead, so this example is the
// adapter between the two — build a web Request from the incoming message, hand it to
// apigen, then write the web Response back onto the ServerResponse.

function readBody(req: IncomingMessage): Promise<Buffer> {
  // biome-ignore lint/complexity/useMaxParams: Promise executor signature is fixed by the language.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const method = req.method ?? 'GET';
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value ?? '']) {
      headers.append(key, item);
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const raw = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body: raw?.length ? raw : undefined });
}

async function sendWebResponse({
  res,
  response,
}: {
  res: ServerResponse;
  response: Response;
}): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    res.setHeader(key, value);
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

// biome-ignore lint/complexity/useMaxParams: node's http request handler signature is (req, res).
const server = createServer((req, res) => {
  toWebRequest(req)
    .then((request) => api.handle(request))
    .then((response) => sendWebResponse({ res, response }))
    .catch(() => {
      res.statusCode = 500;
      res.end();
    });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`listening on http://localhost:${port}`));
