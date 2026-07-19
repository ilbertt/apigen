import { type Authorization, authorize } from './authorize.js';
import {
  compileDelete,
  compileFunction,
  compileInsert,
  compileSelect,
  compileUpdate,
} from './compile.js';
import type {
  Adapter,
  Catalog,
  FunctionArgs,
  FunctionCatalog,
  FunctionConfig,
  FunctionModule,
  Op,
  RelationColumns,
  RelationModule,
} from './contract.js';
import { ApiError, buildResponse, HttpStatus, jsonError } from './http.js';
import { filterColumns, parseRequest } from './parse.js';

const METHOD_OP: Record<string, Op> = {
  GET: 'select',
  POST: 'insert',
  PATCH: 'update',
  DELETE: 'delete',
};

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
}

interface Preferences {
  return: 'minimal' | 'representation';
  count: boolean;
}

function badRequest(message: string): never {
  throw new ApiError({ status: HttpStatus.BadRequest, message });
}

function parsePreferences(req: Request): Preferences {
  const prefer = req.headers.get('prefer') ?? '';
  return {
    return: prefer.includes('return=representation') ? 'representation' : 'minimal',
    count: prefer.includes('count=exact'),
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

async function handleSelect({
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
  const auth = await authorize({ req, op: 'select', module, columns });
  const referenced = [
    ...(parsed.select?.map((item) => item.column) ?? []),
    ...filterColumns(parsed.filters),
    ...parsed.order.map((o) => o.column),
  ];
  ensureAllowed({ cols: referenced, auth, relation });
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

function writeResponse({
  prefs,
  result,
  numerator,
  representationStatus,
  minimalStatus,
}: {
  prefs: Preferences;
  result: Rendered;
  numerator: string;
  representationStatus: number;
  minimalStatus: number;
}): Response {
  const headers: Record<string, string> = {
    'content-range': contentRange({ numerator, total: null }),
  };
  if (prefs.return === 'representation') {
    headers['preference-applied'] = 'return=representation';
    return buildResponse({ status: representationStatus, body: result.body, headers });
  }
  return buildResponse({ status: minimalStatus, body: null, headers });
}

async function handleInsert({
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
  const auth = await authorize({ req, op: 'insert', module, columns });
  const body = await readBody(req);
  const rows = (Array.isArray(body) ? body : [body]) as Row[];
  if (rows.length === 0) {
    badRequest('Insert body must contain at least one row');
  }
  const insertColumns = Object.keys(rows[0] as Row);
  if (insertColumns.length === 0) {
    badRequest('Insert row must have at least one column');
  }
  ensureAllowed({ cols: insertColumns, auth, relation });
  const prefs = parsePreferences(req);
  const returning = parsed.select ?? auth.allowedColumns.map((column) => ({ column }));
  ensureAllowed({ cols: returning.map((item) => item.column), auth, relation });

  const { query, rowCount } = compileInsert({
    relation,
    columns,
    rows,
    insertColumns,
    policy: auth.policy,
    returning,
  });
  const result = await adapter.transaction(async (tx) => {
    const rendered = (await tx.execute(query))[0] as Rendered;
    if (rendered.page !== rowCount) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `Insert into "${relation}" violates the WITH CHECK policy`,
      });
    }
    return rendered;
  });
  // POST is 201 whether or not the body is returned; PostgREST reports no row range.
  return writeResponse({
    prefs,
    result,
    numerator: '*',
    representationStatus: HttpStatus.Created,
    minimalStatus: HttpStatus.Created,
  });
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

export async function handleRequest({
  req,
  catalog,
  functionCatalog,
  modules,
  functions,
  adapter,
}: {
  req: Request;
  catalog: Catalog;
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

    const args = { req, url, relation, columns, module, adapter };
    let response: Response;
    switch (op) {
      case 'select':
        response = await handleSelect(args);
        break;
      case 'insert':
        response = await handleInsert(args);
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

    if (config?.afterExecute) {
      return await config.afterExecute({ req, op, relation, response });
    }
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
