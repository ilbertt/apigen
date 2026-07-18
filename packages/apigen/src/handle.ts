import { type Authorization, authorize } from './authorize.js';
import {
  type ConflictTarget,
  compileDelete,
  compileFunction,
  compileInsert,
  compileSelect,
  compileUpdate,
  type EmbedPlan,
} from './compile.js';
import {
  type Adapter,
  type Catalog,
  type EmbedItem,
  type ForeignKeys,
  type FunctionArgs,
  type FunctionCatalog,
  type FunctionConfig,
  type FunctionModule,
  isFilterGroup,
  type Op,
  type PrimaryKeys,
  type RelationColumns,
  type RelationModule,
  type WhereNode,
} from './contract.js';
import { ApiError, buildResponse, HttpStatus, jsonError } from './http.js';
import { filterColumns, parseRequest } from './parse.js';

const METHOD_OP: Record<string, Op> = {
  GET: 'select',
  HEAD: 'select', // same as GET, but the body is dropped before sending
  POST: 'insert',
  PUT: 'insert', // a single-row upsert keyed by the PK; dispatched to handlePut
  PATCH: 'update',
  DELETE: 'delete',
};

/** OPTIONS `Allow` order (PostgREST's): the methods each mounted op unlocks. */
const OP_METHODS: readonly { op: Op; methods: readonly string[] }[] = [
  { op: 'select', methods: ['GET', 'HEAD'] },
  { op: 'insert', methods: ['POST', 'PUT'] },
  { op: 'update', methods: ['PATCH'] },
  { op: 'delete', methods: ['DELETE'] },
];

/** Functions are called under this path prefix: `POST /rpc/<name>`. */
const RPC_PREFIX = 'rpc';

/** PostgREST's singular representation: exactly one object, or 406. */
const SINGULAR_MEDIA = 'application/vnd.pgrst.object+json';

/** SQLSTATE → HTTP status, following PostgREST's mapping for the common cases. */
const PG_STATUS: Record<string, number> = {
  '23503': HttpStatus.Conflict,
  '23505': HttpStatus.Conflict,
  '42P01': HttpStatus.NotFound,
  '42883': HttpStatus.NotFound,
  '42501': HttpStatus.Forbidden,
};

type Row = Record<string, unknown>;

/** One rendered row: the JSON text Postgres produced plus the page/affected count. */
interface Rendered {
  body: string;
  page: number;
  total?: number;
  /** JSON text array of updated-row ctids (update only); parsed for WITH CHECK re-verification. */
  ctids?: string;
  /** Upsert only: 1 if a conflict UPDATED an existing row (→ 200), 0 if it INSERTED (→ 201). */
  updated?: number;
}

interface Preferences {
  return: 'minimal' | 'representation' | 'headers-only';
  count: boolean;
  resolution?: 'merge-duplicates' | 'ignore-duplicates';
}

function badRequest(message: string): never {
  throw new ApiError({ status: HttpStatus.BadRequest, message });
}

function preferredReturn(prefer: string): Preferences['return'] {
  if (prefer.includes('return=representation')) {
    return 'representation';
  }
  if (prefer.includes('return=headers-only')) {
    return 'headers-only';
  }
  return 'minimal';
}

function preferredResolution(prefer: string): Preferences['resolution'] {
  if (prefer.includes('resolution=merge-duplicates')) {
    return 'merge-duplicates';
  }
  if (prefer.includes('resolution=ignore-duplicates')) {
    return 'ignore-duplicates';
  }
  return undefined;
}

function parsePreferences(req: Request): Preferences {
  const prefer = req.headers.get('prefer') ?? '';
  return {
    return: preferredReturn(prefer),
    count: prefer.includes('count=exact'),
    resolution: preferredResolution(prefer),
  };
}

function wantsSingular(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes(SINGULAR_MEDIA);
}

const RANGE_RE = /^(\d+)-(\d*)$/;

/**
 * PostgREST `Range: <from>-<to>` items pagination — an alternative to `limit`/`offset`.
 * `0-9` → offset 0, limit 10; `10-` → offset 10, no limit. A non-`items` `Range-Unit`
 * is ignored (not a row range).
 */
function parseRange(req: Request): { offset: number; limit?: number } | undefined {
  const range = req.headers.get('range');
  if (range === null) {
    return undefined;
  }
  const unit = req.headers.get('range-unit');
  if (unit !== null && unit !== 'items') {
    return undefined;
  }
  const match = RANGE_RE.exec(range.trim());
  if (match === null) {
    badRequest(`Invalid Range header "${range}"`);
  }
  const from = Number(match[1]);
  const to = match[2] ? Number(match[2]) : undefined;
  if (to !== undefined && to < from) {
    badRequest(`Invalid Range header "${range}": end is before start`);
  }
  return to === undefined ? { offset: from } : { offset: from, limit: to - from + 1 };
}

function rowRange({ offset, page }: { offset: number; page: number }): string {
  return page > 0 ? `${offset}-${offset + page - 1}` : '*';
}

function contentRange({ numerator, total }: { numerator: string; total: number | null }): string {
  return `${numerator}/${total ?? '*'}`;
}

function relationNameFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const name = segments.at(-1);
  if (name === undefined) {
    throw new ApiError({ status: HttpStatus.NotFound, message: 'No relation in request path' });
  }
  return decodeURIComponent(name);
}

function ensureAllowed({
  cols,
  auth,
  relation,
}: {
  cols: readonly string[];
  auth: Authorization;
  relation: string;
}): void {
  for (const col of cols) {
    if (!auth.allowedColumns.includes(col)) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `Column "${col}" is not allowed on relation "${relation}"`,
      });
    }
  }
}

function ensureCatalog({
  cols,
  columns,
  relation,
}: {
  cols: readonly string[];
  columns: RelationColumns;
  relation: string;
}): void {
  for (const col of cols) {
    if (!(col in columns)) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `Unknown column "${col}" on relation "${relation}"`,
      });
    }
  }
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return badRequest('Request body must be valid JSON');
  }
}

/** A function call's args: a JSON object of `arg → value`. An empty body means no args. */
async function readFunctionArgs(req: Request): Promise<Row> {
  const text = await req.text();
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest('Function arguments must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return badRequest('Function arguments must be a JSON object');
  }
  return parsed as Row;
}

function ensureArgs({
  provided,
  args,
  name,
}: {
  provided: readonly string[];
  args: FunctionArgs;
  name: string;
}): void {
  for (const arg of provided) {
    if (!(arg in args)) {
      throw new ApiError({
        status: HttpStatus.BadRequest,
        message: `Function "${name}" has no argument "${arg}"`,
      });
    }
  }
}

async function runOne(args: {
  adapter: Adapter;
  query: { text: string; values: unknown[] };
}): Promise<Rendered> {
  const rows = await args.adapter.transaction((tx) => tx.execute(args.query));
  return rows[0] as Rendered;
}

async function handleFunction({
  req,
  name,
  args,
  config,
  adapter,
}: {
  req: Request;
  name: string;
  args: FunctionArgs;
  config: Readonly<FunctionConfig>;
  adapter: Adapter;
}): Promise<Response> {
  const allowed = config.authorization ? await config.authorization(req) : true;
  if (!allowed) {
    throw new ApiError({
      status: HttpStatus.Forbidden,
      message: `Denied call to function "${name}"`,
    });
  }
  const body = await readFunctionArgs(req);
  ensureArgs({ provided: Object.keys(body), args, name });

  const query = compileFunction({ name, args, body });
  const rows = await adapter.transaction((tx) => tx.execute(query));
  return buildResponse({ status: HttpStatus.Ok, body: JSON.stringify(rows) });
}

async function handleRpc({
  req,
  name,
  functions,
  functionCatalog,
  adapter,
}: {
  req: Request;
  name: string;
  functions: ReadonlyMap<string, FunctionModule>;
  functionCatalog: FunctionCatalog;
  adapter: Adapter;
}): Promise<Response> {
  if (req.method !== 'POST') {
    throw new ApiError({
      status: HttpStatus.MethodNotAllowed,
      message: `Method ${req.method} is not supported on functions (use POST)`,
    });
  }
  const module = functions.get(name);
  const args = functionCatalog[name];
  if (module?.config === undefined || args === undefined) {
    throw new ApiError({
      status: HttpStatus.NotFound,
      message: `Function "${name}" is not exposed`,
    });
  }
  const config = module.config;

  if (config.beforeExecute) {
    await config.beforeExecute({ req, functionName: name });
  }
  const response = await handleFunction({ req, name, args, config, adapter });
  if (config.afterExecute) {
    return await config.afterExecute({ req, functionName: name, response });
  }
  return response;
}

/** Resolve the FK linking `base` and `target` into a join spec, or undefined if none. */
function resolveLink({
  base,
  target,
  foreignKeys,
}: {
  base: string;
  target: string;
  foreignKeys: ForeignKeys;
}): { cardinality: 'many' | 'one'; localColumn: string; foreignColumn: string } | undefined {
  const outward = (foreignKeys[base] ?? []).find((fk) => fk.foreignRelation === target);
  if (outward?.columns[0] !== undefined && outward.foreignColumns[0] !== undefined) {
    return {
      cardinality: 'one',
      localColumn: outward.columns[0],
      foreignColumn: outward.foreignColumns[0],
    };
  }
  const inward = (foreignKeys[target] ?? []).find((fk) => fk.foreignRelation === base);
  if (inward?.columns[0] !== undefined && inward.foreignColumns[0] !== undefined) {
    return {
      cardinality: 'many',
      localColumn: inward.foreignColumns[0],
      foreignColumn: inward.columns[0],
    };
  }
  return undefined;
}

/** Turn parsed embeds into compile plans: resolve the FK, mount, authorize, and columns. */
async function resolveEmbeds({
  embeds,
  base,
  catalog,
  modules,
  foreignKeys,
  req,
}: {
  embeds: readonly EmbedItem[];
  base: string;
  catalog: Catalog;
  modules: ReadonlyMap<string, RelationModule>;
  foreignKeys: ForeignKeys;
  req: Request;
}): Promise<EmbedPlan[]> {
  const plans: EmbedPlan[] = [];
  for (const embed of embeds) {
    const target = embed.relation;
    const embedModule = modules.get(target);
    const embedColumns = catalog[target];
    if (embedModule === undefined || embedColumns === undefined) {
      throw new ApiError({
        status: HttpStatus.BadRequest,
        code: 'PGRST200',
        message: `Could not embed "${target}": it is not an exposed relation`,
      });
    }
    const link = resolveLink({ base, target, foreignKeys });
    if (link === undefined) {
      throw new ApiError({
        status: HttpStatus.BadRequest,
        code: 'PGRST200',
        message: `Could not find a relationship between "${base}" and "${target}"`,
      });
    }
    const auth = await authorize({ req, op: 'select', module: embedModule, columns: embedColumns });
    const select = embed.select ?? auth.allowedColumns.map((column) => ({ column }));
    const referenced = [
      ...select.map((item) => item.column),
      ...filterColumns(embed.filters ?? []),
      ...(embed.order ?? []).map((o) => o.column),
    ];
    ensureAllowed({ cols: referenced, auth, relation: target });
    plans.push({
      alias: embed.alias ?? target,
      relation: target,
      columns: embedColumns,
      select,
      policy: auth.policy,
      ...(embed.inner && { inner: true }),
      ...(embed.filters && embed.filters.length > 0 && { filters: embed.filters }),
      ...(embed.order && embed.order.length > 0 && { order: embed.order }),
      ...(embed.limit !== undefined && { limit: embed.limit }),
      ...(embed.offset !== undefined && { offset: embed.offset }),
      ...link,
    });
  }
  return plans;
}

async function handleSelect({
  req,
  url,
  relation,
  columns,
  module,
  adapter,
  catalog,
  modules,
  foreignKeys,
}: {
  req: Request;
  url: URL;
  relation: string;
  columns: RelationColumns;
  module: RelationModule;
  adapter: Adapter;
  catalog: Catalog;
  modules: ReadonlyMap<string, RelationModule>;
  foreignKeys: ForeignKeys;
}): Promise<Response> {
  const parsed = parseRequest(url);
  const auth = await authorize({ req, op: 'select', module, columns });
  const referenced = [
    // `count()` has an empty column and isn't subject to the allow-list.
    ...(parsed.select?.map((item) => item.column).filter((column) => column !== '') ?? []),
    ...filterColumns(parsed.filters),
    ...parsed.order.map((o) => o.column),
  ];
  ensureAllowed({ cols: referenced, auth, relation });
  const embeds =
    parsed.embed === undefined
      ? []
      : await resolveEmbeds({
          embeds: parsed.embed,
          base: relation,
          catalog,
          modules,
          foreignKeys,
          req,
        });
  const prefs = parsePreferences(req);
  const singular = wantsSingular(req);

  // A `Range` header supplies offset/limit only when the query string didn't — the
  // `limit`/`offset` params take precedence over the legacy header.
  const range = parseRange(req);
  const paged =
    range !== undefined && parsed.limit === undefined && parsed.offset === undefined
      ? { ...parsed, offset: range.offset, limit: range.limit }
      : parsed;

  const query = compileSelect({
    relation,
    columns,
    parsed: paged,
    policy: auth.policy,
    allowedColumns: auth.allowedColumns,
    count: prefs.count,
    embeds,
  });
  const result = await runOne({ adapter, query });
  const offset = paged.offset ?? 0;
  const total = prefs.count ? (result.total ?? 0) : null;
  const headers: Record<string, string> = {};
  if (prefs.count) {
    headers['preference-applied'] = 'count=exact';
  }

  if (singular) {
    if (result.page !== 1) {
      throw new ApiError({
        status: HttpStatus.NotAcceptable,
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: `The result contains ${result.page} rows`,
      });
    }
    headers['content-range'] = contentRange({ numerator: rowRange({ offset, page: 1 }), total });
    headers['content-type'] = `${SINGULAR_MEDIA}; charset=utf-8`;
    // json_agg renders a one-element array `[<obj>]`; unwrap to the object byte-for-byte.
    return buildResponse({ status: HttpStatus.Ok, body: result.body.slice(1, -1), headers });
  }

  headers['content-range'] = contentRange({
    numerator: rowRange({ offset, page: result.page }),
    total,
  });
  const partial = total !== null && offset + result.page < total;
  return buildResponse({
    status: partial ? HttpStatus.PartialContent : HttpStatus.Ok,
    body: result.body,
    headers,
  });
}

/** PostgREST's PK-derived resource URL, e.g. `/orders?id=eq.2` (composite → `&`-joined). */
function locationFor({
  relation,
  pk,
  row,
}: {
  relation: string;
  pk: readonly string[];
  row: Row;
}): string {
  const query = pk.map((col) => `${col}=eq.${encodeURIComponent(String(row[col]))}`).join('&');
  return `/${relation}?${query}`;
}

/** PostgREST echoes the honored non-default preferences, e.g. `resolution=…, return=…`. */
function preferenceApplied(prefs: Preferences): string | undefined {
  const applied: string[] = [];
  if (prefs.resolution !== undefined) {
    applied.push(`resolution=${prefs.resolution}`);
  }
  if (prefs.return === 'representation' || prefs.return === 'headers-only') {
    applied.push(`return=${prefs.return}`);
  }
  return applied.length > 0 ? applied.join(', ') : undefined;
}

function writeResponse({
  prefs,
  result,
  numerator,
  representationStatus,
  minimalStatus,
  location,
}: {
  prefs: Preferences;
  result: Rendered;
  numerator: string;
  representationStatus: number;
  minimalStatus: number;
  location?: string;
}): Response {
  const headers: Record<string, string> = {
    'content-range': contentRange({ numerator, total: null }),
  };
  const applied = preferenceApplied(prefs);
  if (applied !== undefined) {
    headers['preference-applied'] = applied;
  }
  if (location !== undefined) {
    headers.location = location;
  }
  const representation = prefs.return === 'representation';
  return buildResponse({
    status: representation ? representationStatus : minimalStatus,
    body: representation ? result.body : null,
    headers,
  });
}

async function handleInsert({
  req,
  url,
  relation,
  columns,
  module,
  adapter,
  primaryKeys,
}: {
  req: Request;
  url: URL;
  relation: string;
  columns: RelationColumns;
  module: RelationModule;
  adapter: Adapter;
  primaryKeys: PrimaryKeys;
}): Promise<Response> {
  const parsed = parseRequest(url);
  const auth = await authorize({ req, op: 'insert', module, columns });
  const body = await readBody(req);
  const rows = (Array.isArray(body) ? body : [body]) as Row[];
  if (rows.length === 0) {
    badRequest('Insert body must contain at least one row');
  }
  // `columns=` fixes the insert column set (body keys outside it are ignored, and its
  // columns absent from a row bind NULL); otherwise the first row's keys define it.
  const insertColumns = parsed.columns ?? Object.keys(rows[0] as Row);
  if (insertColumns.length === 0) {
    badRequest('Insert row must have at least one column');
  }
  ensureAllowed({ cols: insertColumns, auth, relation });
  const prefs = parsePreferences(req);
  const pk = primaryKeys[relation] ?? [];
  // headers-only returns no body but needs the PK to fill Location; otherwise return
  // the representation columns (used only when the client asked for them).
  const wantLocation = prefs.return === 'headers-only' && pk.length > 0;
  const returning = wantLocation
    ? pk.map((column) => ({ column }))
    : (parsed.select ?? auth.allowedColumns.map((column) => ({ column })));
  // The PK behind a headers-only Location is internal (it names the created resource
  // in a header, not the body), so it isn't subject to the column allow-list — but a
  // client-visible representation is.
  if (!wantLocation) {
    ensureAllowed({ cols: returning.map((item) => item.column), auth, relation });
  }

  // An upsert (Prefer: resolution=…) targets on_conflict columns, or the PK by default.
  const conflictColumns = parsed.onConflict ?? pk;
  const conflict: ConflictTarget | undefined =
    prefs.resolution !== undefined && conflictColumns.length > 0
      ? {
          columns: conflictColumns,
          action: prefs.resolution === 'merge-duplicates' ? 'merge' : 'ignore',
        }
      : undefined;

  const { query, rowCount } = compileInsert({
    relation,
    columns,
    rows,
    insertColumns,
    policy: auth.policy,
    returning,
    conflict,
  });
  const result = await adapter.transaction(async (tx) => {
    const rendered = (await tx.execute(query))[0] as Rendered;
    // ignore-duplicates legitimately drops conflicting rows, so a short count isn't a
    // policy violation; every other write must return every requested row.
    if (conflict?.action !== 'ignore' && rendered.page !== rowCount) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `Insert into "${relation}" violates the WITH CHECK policy`,
      });
    }
    return rendered;
  });
  const inserted = wantLocation ? (JSON.parse(result.body) as Row[])[0] : undefined;
  const location =
    inserted === undefined ? undefined : locationFor({ relation, pk, row: inserted });
  // POST is 201, except an upsert that UPDATED an existing row answers 200 (PostgREST's
  // rule). PostgREST reports no row range for a write.
  const status = result.updated === 1 ? HttpStatus.Ok : HttpStatus.Created;
  return writeResponse({
    prefs,
    result,
    numerator: '*',
    representationStatus: status,
    minimalStatus: status,
    location,
  });
}

/** The URL filter of a PUT must be exactly the PK columns, each an `eq` — else not a PUT target. */
function pkEqValues({
  filters,
  pk,
}: {
  filters: readonly WhereNode[];
  pk: readonly string[];
}): Map<string, string> | undefined {
  if (pk.length === 0 || filters.length !== pk.length) {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const node of filters) {
    if (isFilterGroup(node) || node.op !== 'eq' || node.negated || !pk.includes(node.column)) {
      return undefined;
    }
    values.set(node.column, node.value);
  }
  return values.size === pk.length ? values : undefined;
}

async function handlePut({
  req,
  url,
  relation,
  columns,
  module,
  adapter,
  primaryKeys,
}: {
  req: Request;
  url: URL;
  relation: string;
  columns: RelationColumns;
  module: RelationModule;
  adapter: Adapter;
  primaryKeys: PrimaryKeys;
}): Promise<Response> {
  const parsed = parseRequest(url);
  const pk = primaryKeys[relation] ?? [];
  // PUT addresses a single row by its whole PK; anything else isn't a valid PUT target.
  const pkFilter = pkEqValues({ filters: parsed.filters, pk });
  if (pkFilter === undefined) {
    throw new ApiError({
      status: HttpStatus.MethodNotAllowed,
      message: 'PUT requires filtering by the entire primary key with eq',
    });
  }
  const auth = await authorize({ req, op: 'insert', module, columns });
  const body = await readBody(req);
  if (Array.isArray(body) || typeof body !== 'object' || body === null) {
    badRequest('PUT body must be a single JSON object');
  }
  const row = body as Row;
  for (const col of pk) {
    if (String(row[col]) !== pkFilter.get(col)) {
      badRequest(`PUT body primary key "${col}" does not match the URL`);
    }
  }
  const insertColumns = parsed.columns ?? Object.keys(row);
  if (insertColumns.length === 0) {
    badRequest('PUT body must have at least one column');
  }
  ensureAllowed({ cols: insertColumns, auth, relation });
  const prefs = parsePreferences(req);
  const returning = parsed.select ?? auth.allowedColumns.map((column) => ({ column }));
  ensureAllowed({ cols: returning.map((item) => item.column), auth, relation });

  const { query, rowCount } = compileInsert({
    relation,
    columns,
    rows: [row],
    insertColumns,
    policy: auth.policy,
    returning,
    conflict: { columns: pk, action: 'merge' },
  });
  const result = await adapter.transaction(async (tx) => {
    const rendered = (await tx.execute(query))[0] as Rendered;
    if (rendered.page !== rowCount) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `PUT on "${relation}" violates the WITH CHECK policy`,
      });
    }
    return rendered;
  });
  // PUT emits no Content-Range. Without a representation the answer is always 204; with
  // one it is 200 when a row was updated, 201 when inserted.
  const representation = prefs.return === 'representation';
  const status = representation
    ? result.updated === 1
      ? HttpStatus.Ok
      : HttpStatus.Created
    : HttpStatus.NoContent;
  const headers: Record<string, string> = {};
  const applied = preferenceApplied(prefs);
  if (applied !== undefined) {
    headers['preference-applied'] = applied;
  }
  return buildResponse({ status, body: representation ? result.body : null, headers });
}

async function handleUpdate({
  req,
  url,
  relation,
  columns,
  module,
  adapter,
}: {
  req: Request;
  url: URL;
  relation: string;
  columns: RelationColumns;
  module: RelationModule;
  adapter: Adapter;
}): Promise<Response> {
  const parsed = parseRequest(url);
  const auth = await authorize({ req, op: 'update', module, columns });
  const body = await readBody(req);
  if (Array.isArray(body) || typeof body !== 'object' || body === null) {
    badRequest('Update body must be a single JSON object');
  }
  const patch = body as Row;
  const setColumns = Object.keys(patch);
  if (setColumns.length === 0) {
    badRequest('Update body must set at least one column');
  }
  ensureAllowed({ cols: setColumns, auth, relation });
  ensureCatalog({ cols: filterColumns(parsed.filters), columns, relation });
  const prefs = parsePreferences(req);
  const returning = parsed.select ?? auth.allowedColumns.map((column) => ({ column }));
  ensureAllowed({ cols: returning.map((item) => item.column), auth, relation });

  const plan = compileUpdate({
    relation,
    columns,
    body: patch,
    setColumns,
    parsed,
    policy: auth.policy,
    returning,
  });
  const result = await adapter.transaction(async (tx) => {
    const rendered = (await tx.execute(plan.update))[0] as Rendered;
    const ctids = rendered.ctids ? (JSON.parse(rendered.ctids) as string[]) : [];
    if (ctids.length > 0) {
      const violations = await tx.execute(plan.verify(ctids));
      if (violations.length > 0) {
        throw new ApiError({
          status: HttpStatus.Forbidden,
          message: `Update on "${relation}" violates the WITH CHECK policy`,
        });
      }
    }
    return rendered;
  });
  return writeResponse({
    prefs,
    result,
    numerator: rowRange({ offset: 0, page: result.page }),
    representationStatus: HttpStatus.Ok,
    minimalStatus: HttpStatus.NoContent,
  });
}

async function handleDelete({
  req,
  url,
  relation,
  columns,
  module,
  adapter,
}: {
  req: Request;
  url: URL;
  relation: string;
  columns: RelationColumns;
  module: RelationModule;
  adapter: Adapter;
}): Promise<Response> {
  const parsed = parseRequest(url);
  const auth = await authorize({ req, op: 'delete', module, columns });
  ensureCatalog({ cols: filterColumns(parsed.filters), columns, relation });
  const prefs = parsePreferences(req);
  const returning = parsed.select ?? auth.allowedColumns.map((column) => ({ column }));
  ensureAllowed({ cols: returning.map((item) => item.column), auth, relation });

  const query = compileDelete({
    relation,
    columns,
    parsed,
    policy: auth.policy,
    returning,
  });
  const result = await runOne({ adapter, query });
  // PostgREST reports no row range for deletes.
  return writeResponse({
    prefs,
    result,
    numerator: '*',
    representationStatus: HttpStatus.Ok,
    minimalStatus: HttpStatus.NoContent,
  });
}

function statusForPg(code: string): number {
  const mapped = PG_STATUS[code];
  if (mapped !== undefined) {
    return mapped;
  }
  switch (code.slice(0, 2)) {
    case '22': // data exception (bad cast, numeric overflow, …)
    case '23': // integrity constraint (non-conflict)
    case '42': // syntax / access rule
    case 'P0': // PL/pgSQL RAISE
      return HttpStatus.BadRequest;
    default:
      return HttpStatus.InternalServerError;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonError({
      status: err.status,
      body: { code: err.code, details: err.details, hint: err.hint, message: err.message },
    });
  }
  // A Postgres driver error: pass its SQLSTATE + message/detail/hint through, as
  // PostgREST does. Read fields directly — `Error.message` is non-enumerable, so a
  // spread would drop it.
  const e = err as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  if (typeof e.code === 'string') {
    return jsonError({
      status: statusForPg(e.code),
      body: {
        code: e.code,
        details: typeof e.detail === 'string' ? e.detail : null,
        hint: typeof e.hint === 'string' ? e.hint : null,
        message: typeof e.message === 'string' ? e.message : 'Database error',
      },
    });
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  return jsonError({
    status: HttpStatus.InternalServerError,
    body: { code: null, details: null, hint: null, message },
  });
}

/** `OPTIONS`: 200 with an `Allow` header listing the methods the relation's mounts permit. */
function handleOptions({
  url,
  modules,
}: {
  url: URL;
  modules: ReadonlyMap<string, RelationModule>;
}): Response {
  const relation = relationNameFromUrl(url);
  const module = modules.get(relation);
  if (module === undefined) {
    throw new ApiError({
      status: HttpStatus.NotFound,
      code: 'PGRST205',
      message: `Relation "${relation}" is not exposed`,
    });
  }
  const methods = ['OPTIONS'];
  for (const { op, methods: unlocked } of OP_METHODS) {
    if (module.handlers[op] !== undefined) {
      methods.push(...unlocked);
    }
  }
  return buildResponse({
    status: HttpStatus.Ok,
    body: null,
    headers: { allow: methods.join(',') },
  });
}

export async function handleRequest({
  req,
  catalog,
  primaryKeys,
  foreignKeys,
  functionCatalog,
  modules,
  functions,
  adapter,
}: {
  req: Request;
  catalog: Catalog;
  primaryKeys: PrimaryKeys;
  foreignKeys: ForeignKeys;
  functionCatalog: FunctionCatalog;
  modules: ReadonlyMap<string, RelationModule>;
  functions: ReadonlyMap<string, FunctionModule>;
  adapter: Adapter;
}): Promise<Response> {
  try {
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    // `/rpc/<name>` routes to a function; a bare `/rpc` falls through so a relation
    // named `rpc` is still reachable.
    const rpcName = segments[0] === RPC_PREFIX ? segments[1] : undefined;
    if (rpcName !== undefined) {
      return await handleRpc({
        req,
        name: decodeURIComponent(rpcName),
        functions,
        functionCatalog,
        adapter,
      });
    }

    if (req.method === 'OPTIONS') {
      return handleOptions({ url, modules });
    }

    const op = METHOD_OP[req.method];
    if (op === undefined) {
      throw new ApiError({
        status: HttpStatus.MethodNotAllowed,
        message: `Method ${req.method} is not supported`,
      });
    }
    const relation = relationNameFromUrl(url);
    const module = modules.get(relation);
    const columns = catalog[relation];
    if (module === undefined || columns === undefined) {
      throw new ApiError({
        status: HttpStatus.NotFound,
        code: 'PGRST205',
        message: `Relation "${relation}" is not exposed`,
      });
    }

    const config = module.handlers[op];
    if (config?.beforeExecute) {
      await config.beforeExecute({ req, op, relation });
    }

    const args = {
      req,
      url,
      relation,
      columns,
      module,
      adapter,
      primaryKeys,
      catalog,
      modules,
      foreignKeys,
    };
    let response: Response;
    switch (op) {
      case 'select':
        response = await handleSelect(args);
        break;
      case 'insert':
        response = req.method === 'PUT' ? await handlePut(args) : await handleInsert(args);
        break;
      case 'update':
        response = await handleUpdate(args);
        break;
      case 'delete':
        response = await handleDelete(args);
        break;
      default:
        throw new ApiError({
          status: HttpStatus.MethodNotAllowed,
          message: `Unsupported operation`,
        });
    }

    const finished = config?.afterExecute
      ? await config.afterExecute({ req, op, relation, response })
      : response;
    // HEAD runs the same query as GET for its headers, but sends no body.
    if (req.method === 'HEAD') {
      return new Response(null, { status: finished.status, headers: finished.headers });
    }
    return finished;
  } catch (err) {
    return errorResponse(err);
  }
}
