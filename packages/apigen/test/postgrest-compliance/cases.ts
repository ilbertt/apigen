/**
 * Request specs for PostgREST compliance. Each case is fired at both a real
 * PostgREST and at apigen in-process (see compliance.test.ts) and asserted to match
 * byte-for-byte. Every case is a behavior apigen guarantees to match; intentional
 * divergences (CSV, embeds, up-front allowedColumns) are out of scope — documented in
 * the README, not parked here as skipped tests.
 */
export interface DiffCase {
  readonly name: string;
  readonly method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

  // logical operators: or / and, a nested group, negation, in() inside a group, and a
  // top-level filter AND-ed with an or-group
  {
    name: 'logical or',
    method: 'GET',
    path: '/orders?or=(customer.eq.Alice,customer.eq.Carol)&order=id',
  },
  {
    name: 'logical and',
    method: 'GET',
    path: '/orders?and=(status.eq.paid,paid.is.true)&order=id',
  },
  {
    name: 'logical or with in()',
    method: 'GET',
    path: '/orders?or=(status.in.(paid),customer.eq.Bob)&order=id',
  },
  {
    name: 'logical nested and inside or',
    method: 'GET',
    path: '/orders?or=(customer.eq.Alice,and(amount.gt.900,paid.is.true))&order=id',
  },
  {
    name: 'logical not.and',
    method: 'GET',
    path: '/orders?not.and=(status.eq.paid,paid.is.true)&order=id',
  },
  {
    name: 'logical or plus top-level filter',
    method: 'GET',
    path: '/orders?status=eq.paid&or=(customer.eq.Alice,customer.eq.Bob)&order=id',
  },

  // vertical filtering: rename (alias:col) and cast (col::type) in select, on reads and writes
  { name: 'select rename', method: 'GET', path: '/orders?select=who:customer,amount&order=id' },
  { name: 'select cast', method: 'GET', path: '/orders?select=id,amount::text&order=id' },
  {
    name: 'select rename + cast',
    method: 'GET',
    path: '/orders?select=total:amount::text&order=id',
  },
  {
    name: 'insert representation with select projection',
    method: 'POST',
    path: '/orders?select=id,who:customer',
    headers: { prefer: 'return=representation' },
    body: { org_id: ACME, customer: 'Dave', amount: 42.0, created_at: '2024-06-01T00:00:00Z' },
  },

  // JSON-path selection over the `meta` jsonb column ({tier, age})
  { name: 'select json ->> (text)', method: 'GET', path: '/orders?select=id,meta->>tier&order=id' },
  { name: 'select json -> (json)', method: 'GET', path: '/orders?select=id,meta->tier&order=id' },
  {
    name: 'select json path aliased',
    method: 'GET',
    path: '/orders?select=id,plan:meta->>tier&order=id',
  },
  {
    name: 'select json path cast',
    method: 'GET',
    path: '/orders?select=id,meta->>age::int&order=id',
  },

  // resource embedding (FK joins): 1:many, many:1, aliased, empty, embed-only
  {
    name: 'embed 1:many (order_items)',
    method: 'GET',
    path: '/orders?select=id,customer,order_items(id,sku,qty)&order=id',
  },
  {
    name: 'embed 1:many all cols',
    method: 'GET',
    path: '/orders?select=id,order_items(*)&id=eq.1',
  },
  {
    name: 'embed 1:many empty (Bob has none)',
    method: 'GET',
    path: '/orders?select=customer,order_items(sku)&id=eq.2',
  },
  {
    name: 'embed many:1 (orders)',
    method: 'GET',
    path: '/order_items?select=id,sku,orders(id,customer)&order=id',
  },
  {
    name: 'embed aliased',
    method: 'GET',
    path: '/orders?select=id,items:order_items(sku)&id=eq.1',
  },
  {
    name: 'embed only (no base cols)',
    method: 'GET',
    path: '/orders?select=order_items(sku)&id=eq.1',
  },
  {
    name: 'embed !inner (drops childless base)',
    method: 'GET',
    path: '/orders?select=customer,order_items!inner(sku)&order=id',
  },
  {
    name: 'embed !inner with count',
    method: 'GET',
    path: '/orders?select=id,order_items!inner(sku)&order=id',
    headers: { prefer: 'count=exact' },
  },
  {
    name: 'embedded filter',
    method: 'GET',
    path: '/orders?select=customer,order_items(sku,qty)&order_items.qty=gt.1&id=eq.1',
  },
  {
    name: 'embedded order + limit',
    method: 'GET',
    path: '/orders?select=customer,order_items(sku)&order_items.order=sku.asc&order_items.limit=1&id=eq.1',
  },
  {
    name: 'embedded order desc',
    method: 'GET',
    path: '/orders?select=customer,order_items(qty)&order_items.order=qty.desc&id=eq.1',
  },
  {
    name: 'embed spread (flatten to-one parent)',
    method: 'GET',
    path: '/order_items?select=sku,...orders(customer,amount)&order=id',
  },

  // aggregates in select (db-aggregates enabled): sum/avg/count/max/min + implicit GROUP BY
  { name: 'aggregate sum', method: 'GET', path: '/orders?select=amount.sum()' },
  { name: 'aggregate count()', method: 'GET', path: '/orders?select=count()' },
  {
    name: 'aggregate grouped by status',
    method: 'GET',
    path: '/orders?select=status,amount.sum(),count()&order=status',
  },
  {
    name: 'aggregate aliased + cast',
    method: 'GET',
    path: '/orders?select=total:amount.sum()::text&status=eq.paid',
  },
  {
    name: 'aggregate avg/max/min',
    method: 'GET',
    path: '/orders?select=amount.avg(),amount.max(),amount.min()',
  },

  { name: 'order desc', method: 'GET', path: '/orders?order=amount.desc' },
  { name: 'order asc nullslast', method: 'GET', path: '/orders?order=amount.asc.nullslast' },
  { name: 'limit', method: 'GET', path: '/orders?order=id&limit=2' },
  { name: 'limit + offset', method: 'GET', path: '/orders?order=id&limit=2&offset=1' },
  { name: 'empty result', method: 'GET', path: '/orders?customer=eq.Nobody' },

  // content negotiation: HEAD mirrors GET headers with no body; OPTIONS lists Allow
  { name: 'head', method: 'HEAD', path: '/orders?order=id' },
  {
    name: 'head count exact',
    method: 'HEAD',
    path: '/orders?order=id',
    headers: { prefer: 'count=exact' },
  },
  { name: 'options', method: 'OPTIONS', path: '/orders' },

  // CSV output: header row + text values, null → empty, no trailing newline
  {
    name: 'csv output',
    method: 'GET',
    path: '/orders?select=id,customer,amount,note&order=id',
    headers: { accept: 'text/csv' },
  },
  {
    name: 'csv with count',
    method: 'GET',
    path: '/orders?select=id,customer&order=id',
    headers: { accept: 'text/csv', prefer: 'count=exact' },
  },

  // Range header pagination (an alternative to limit/offset)
  {
    name: 'range items 0-1',
    method: 'GET',
    path: '/orders?order=id',
    headers: { range: '0-1', 'range-unit': 'items' },
  },
  { name: 'range items 1-2', method: 'GET', path: '/orders?order=id', headers: { range: '1-2' } },
  { name: 'range open-ended', method: 'GET', path: '/orders?order=id', headers: { range: '2-' } },
  {
    name: 'range with count exact',
    method: 'GET',
    path: '/orders?order=id',
    headers: { range: '0-1', prefer: 'count=exact' },
  },

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
  {
    name: 'insert headers-only (Location from PK)',
    method: 'POST',
    path: '/orders',
    headers: { prefer: 'return=headers-only' },
    body: { org_id: ACME, customer: 'Dave', amount: 42.0, created_at: '2024-06-01T00:00:00Z' },
  },
  {
    name: 'update headers-only',
    method: 'PATCH',
    path: '/orders?customer=eq.Alice',
    headers: { prefer: 'return=headers-only' },
    body: { status: 'shipped' },
  },
  { name: 'delete default (minimal)', method: 'DELETE', path: '/orders?customer=eq.Bob' },
  {
    name: 'delete representation',
    method: 'DELETE',
    path: '/orders?customer=eq.Bob',
    headers: { prefer: 'return=representation' },
  },

  // upsert via POST: on_conflict target + Prefer: resolution (products: WIDGET, GADGET)
  {
    name: 'upsert merge existing (representation)',
    method: 'POST',
    path: '/products?on_conflict=sku',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: { sku: 'WIDGET', name: 'Widget v2', price: 30, stock: 5 },
  },
  {
    name: 'upsert merge new (minimal)',
    method: 'POST',
    path: '/products?on_conflict=sku',
    headers: { prefer: 'resolution=merge-duplicates' },
    body: { sku: 'GROMMET', name: 'Grommet', price: 8, stock: 3 },
  },
  {
    name: 'upsert ignore existing (representation is empty)',
    method: 'POST',
    path: '/products?on_conflict=sku',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: { sku: 'GADGET', name: 'IGNORED', price: 99, stock: 99 },
  },
  {
    name: 'upsert ignore new (representation)',
    method: 'POST',
    path: '/products?on_conflict=sku',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: { sku: 'SPROCKET', name: 'Sprocket', price: 12, stock: 7 },
  },
  {
    name: 'upsert default target = PK (representation)',
    method: 'POST',
    path: '/products',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: { sku: 'WIDGET', name: 'Widget PK', price: 26, stock: 9 },
  },

  // columns=: only the named columns are inserted; the rest take DB defaults
  {
    name: 'insert with columns= (rest default)',
    method: 'POST',
    path: '/products?columns=sku,name',
    headers: { prefer: 'return=representation' },
    body: { sku: 'ZED', name: 'Zed', price: 999, stock: 999 },
  },

  // PUT: single-row upsert keyed by the whole PK (no Content-Range; 200 update / 201 insert)
  {
    name: 'put existing (representation → 200)',
    method: 'PUT',
    path: '/products?sku=eq.WIDGET',
    headers: { prefer: 'return=representation' },
    body: { sku: 'WIDGET', name: 'Widget v3', price: 31, stock: 8 },
  },
  {
    name: 'put existing (minimal → 204)',
    method: 'PUT',
    path: '/products?sku=eq.WIDGET',
    body: { sku: 'WIDGET', name: 'Widget v4', price: 32, stock: 6 },
  },
  {
    name: 'put new (representation → 201)',
    method: 'PUT',
    path: '/products?sku=eq.NEWBIE',
    headers: { prefer: 'return=representation' },
    body: { sku: 'NEWBIE', name: 'Newbie', price: 1, stock: 1 },
  },
  {
    name: 'put new (minimal)',
    method: 'PUT',
    path: '/products?sku=eq.FRESH',
    body: { sku: 'FRESH', name: 'Fresh', price: 2, stock: 2 },
  },
  // PUT's 405 (non-PK filter) and 400 (PK mismatch) are apigen-generated error bodies,
  // which don't match PostgREST byte-for-byte — they're asserted in the hermetic suite.

  // singular response
  {
    name: 'singular object',
    method: 'GET',
    path: '/orders?id=eq.1',
    headers: { accept: 'application/vnd.pgrst.object+json' },
  },
];
