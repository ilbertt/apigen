import { db } from './db.ts';

export interface Caller {
  id: string;
}

const cache = new WeakMap<Request, Promise<Caller | null>>();

/**
 * Resolve `Authorization: Bearer <token>` to a customer by reading the unexposed
 * `customers` table. Memoized on the Request (via a WeakMap) so it runs once even
 * though every relation policy calls it.
 */
export function auth(req: Request): Promise<Caller | null> {
  let result = cache.get(req);
  if (!result) {
    result = resolve(req);
    cache.set(req, result);
  }
  return result;
}

async function resolve(req: Request): Promise<Caller | null> {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return null;
  }
  const [row] = await db`select id from customers where api_token = ${token}`;
  if (!row) {
    return null;
  }
  return { id: row.id as string };
}
