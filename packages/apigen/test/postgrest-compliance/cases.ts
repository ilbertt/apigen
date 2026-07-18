/**
 * Request specs for PostgREST compliance. Each case is fired at both a real
 * PostgREST and at apigen in-process (see compliance.test.ts) and asserted to match
 * byte-for-byte. Every case is a behavior apigen guarantees to match; intentional
 * divergences (logical operators, full-text, CSV, up-front allowedColumns) are out of
 * scope — documented in the README, not parked here as skipped tests.
 */
export interface DiffCase {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

const ACME = '11111111-1111-1111-1111-111111111111';

export const CASES: DiffCase[] = [
  // reads: projection, filters, ordering, pagination
  { name: 'list orders', method: 'GET', path: '/orders?order=id' },
  { name: 'select projection', method: 'GET', path: '/orders?select=id,customer&order=id' },
  { name: 'filter eq', method: 'GET', path: '/orders?customer=eq.Alice' },
  { name: 'filter neq', method: 'GET', path: '/orders?customer=neq.Alice&order=id' },
  { name: 'filter gt (numeric)', method: 'GET', path: '/orders?amount=gt.100&order=id' },
  { name: 'filter gte (numeric)', method: 'GET', path: '/orders?amount=gte.100&order=id' },
  { name: 'filter lt (numeric)', method: 'GET', path: '/orders?amount=lt.100&order=id' },
  { name: 'filter lte (numeric)', method: 'GET', path: '/orders?amount=lte.100&order=id' },
  { name: 'filter in', method: 'GET', path: '/orders?status=in.(paid,pending)&order=id' },
  { name: 'filter is true', method: 'GET', path: '/orders?paid=is.true&order=id' },
  { name: 'filter is false', method: 'GET', path: '/orders?paid=is.false&order=id' },
  { name: 'filter like', method: 'GET', path: '/orders?customer=like.A*&order=id' },
  { name: 'filter ilike', method: 'GET', path: '/orders?customer=ilike.a*&order=id' },
  { name: 'order desc', method: 'GET', path: '/orders?order=amount.desc' },
  { name: 'order asc nullslast', method: 'GET', path: '/orders?order=amount.asc.nullslast' },
  { name: 'limit', method: 'GET', path: '/orders?order=id&limit=2' },
  { name: 'limit + offset', method: 'GET', path: '/orders?order=id&limit=2&offset=1' },
  { name: 'empty result', method: 'GET', path: '/orders?customer=eq.Nobody' },

  // counting: Content-Range with Prefer: count=exact
  {
    name: 'count exact',
    method: 'GET',
    path: '/orders?order=id',
    headers: { prefer: 'count=exact' },
  },

  // errors: a database error passes through with PostgREST's envelope
  { name: 'bad numeric cast', method: 'GET', path: '/orders?amount=eq.notanumber' },

  // writes: default (minimal) vs representation
  {
    name: 'insert default (minimal)',
    method: 'POST',
    path: '/orders',
    body: { org_id: ACME, customer: 'Dave', amount: 42.0, created_at: '2024-06-01T00:00:00Z' },
  },
  {
    name: 'insert representation',
    method: 'POST',
    path: '/orders',
    headers: { prefer: 'return=representation' },
    body: { org_id: ACME, customer: 'Dave', amount: 42.0, created_at: '2024-06-01T00:00:00Z' },
  },
  {
    name: 'update default (minimal)',
    method: 'PATCH',
    path: '/orders?customer=eq.Alice',
    body: { status: 'shipped' },
  },
  {
    name: 'update representation',
    method: 'PATCH',
    path: '/orders?customer=eq.Alice',
    headers: { prefer: 'return=representation' },
    body: { status: 'shipped' },
  },
  { name: 'delete default (minimal)', method: 'DELETE', path: '/orders?customer=eq.Bob' },
  {
    name: 'delete representation',
    method: 'DELETE',
    path: '/orders?customer=eq.Bob',
    headers: { prefer: 'return=representation' },
  },

  // singular response
  {
    name: 'singular object',
    method: 'GET',
    path: '/orders?id=eq.1',
    headers: { accept: 'application/vnd.pgrst.object+json' },
  },
];
