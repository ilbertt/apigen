/**
 * Request specs for PostgREST compliance. Each case is fired at both a real
 * PostgREST and at apigen in-process (see compliance.test.ts) and asserted to match
 * byte-for-byte. Every case is a behavior apigen guarantees to match; intentional
 * divergences (logical operators, CSV, up-front allowedColumns) are out of scope —
 * documented in the README, not parked here as skipped tests.
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

  // regex (match/imatch): POSIX regex, so `*` is NOT a wildcard the way like uses it
  { name: 'filter match', method: 'GET', path: '/orders?customer=match.^A&order=id' },
  { name: 'filter imatch', method: 'GET', path: '/orders?customer=imatch.^a&order=id' },

  // NULL semantics: note is nullable (Bob is NULL). isdistinct is the NULL-safe <>,
  // so it must include the NULL row where a plain neq would drop it.
  { name: 'filter is null', method: 'GET', path: '/orders?note=is.null&order=id' },
  {
    name: 'filter isdistinct (keeps null row)',
    method: 'GET',
    path: '/orders?note=isdistinct.vip&order=id',
  },

  // negation: not. wraps the whole condition; NULL rows follow SQL three-valued logic
  { name: 'filter not.eq', method: 'GET', path: '/orders?customer=not.eq.Alice&order=id' },
  { name: 'filter not.in', method: 'GET', path: '/orders?status=not.in.(paid)&order=id' },
  { name: 'filter not.like', method: 'GET', path: '/orders?customer=not.like.A*&order=id' },
  { name: 'filter not.is null', method: 'GET', path: '/orders?note=not.is.null&order=id' },
  { name: 'filter not.match', method: 'GET', path: '/orders?customer=not.match.^A&order=id' },

  // full-text search over the `description` prose column
  { name: 'filter fts', method: 'GET', path: '/orders?description=fts.red&order=id' },
  {
    name: 'filter fts (config)',
    method: 'GET',
    path: '/orders?description=fts(english).bicycle&order=id',
  },
  { name: 'filter plfts', method: 'GET', path: '/orders?description=plfts.red%20car&order=id' },
  { name: 'filter phfts', method: 'GET', path: '/orders?description=phfts.red%20car&order=id' },
  { name: 'filter wfts', method: 'GET', path: '/orders?description=wfts.car&order=id' },
  { name: 'filter not.fts', method: 'GET', path: '/orders?description=not.fts.red&order=id' },

  // array operators over `tags` (Alice {vip,priority}, Bob {}, Carol {vip})
  { name: 'filter cs (array contains)', method: 'GET', path: '/orders?tags=cs.{vip}&order=id' },
  { name: 'filter cd (array contained)', method: 'GET', path: '/orders?tags=cd.{vip}&order=id' },
  { name: 'filter ov (array overlap)', method: 'GET', path: '/orders?tags=ov.{priority}&order=id' },
  { name: 'filter not.cs (array)', method: 'GET', path: '/orders?tags=not.cs.{vip}&order=id' },

  // range operators over `span` (Alice [1,10), Bob [5,15), Carol [20,30))
  { name: 'filter cs (range contains)', method: 'GET', path: '/orders?span=cs.[2,5)&order=id' },
  { name: 'filter sl (strictly left)', method: 'GET', path: '/orders?span=sl.[20,30)&order=id' },
  { name: 'filter sr (strictly right)', method: 'GET', path: '/orders?span=sr.[1,3)&order=id' },
  { name: 'filter nxr (not right of)', method: 'GET', path: '/orders?span=nxr.[10,20)&order=id' },
  { name: 'filter nxl (not left of)', method: 'GET', path: '/orders?span=nxl.[10,20)&order=id' },
  { name: 'filter adj (adjacent)', method: 'GET', path: '/orders?span=adj.[10,20)&order=id' },

  // any/all quantifiers: the operator is applied against a {…} array of operands
  { name: 'filter eq(any)', method: 'GET', path: '/orders?id=eq(any).{1,2}&order=id' },
  { name: 'filter like(any)', method: 'GET', path: '/orders?customer=like(any).{A*,C*}&order=id' },
  { name: 'filter like(all)', method: 'GET', path: '/orders?customer=like(all).{A*,*e}&order=id' },
  { name: 'filter gt(all)', method: 'GET', path: '/orders?amount=gt(all).{50,90}&order=id' },
  { name: 'filter not.eq(any)', method: 'GET', path: '/orders?id=not.eq(any).{1}&order=id' },

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
