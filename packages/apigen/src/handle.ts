import { type Authorization, authorize } from './authorize.js';
import { CTID_KEY, compileDelete, compileInsert, compileSelect, compileUpdate } from './compile.js';
import type { Adapter, Catalog, Op, RelationColumns, RelationModule } from './contract.js';
import { ApiError, HttpStatus, jsonResponse } from './http.js';
import { parseRequest } from './parse.js';

const METHOD_OP: Record<string, Op> = {
  GET: 'select',
  POST: 'insert',
  PATCH: 'update',
  DELETE: 'delete',
};

/** Postgres SQLSTATE class 22 = data exception (bad cast, etc.) → client error. */
const PG_DATA_EXCEPTION_CLASS = '22';

type Row = Record<string, unknown>;

function badRequest(message: string): never {
  throw new ApiError({ status: HttpStatus.BadRequest, message });
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
    ...(parsed.select ?? []),
    ...parsed.filters.map((f) => f.column),
    ...parsed.order.map((o) => o.column),
  ];
  ensureAllowed({ cols: referenced, auth, relation });

  const query = compileSelect({
    relation,
    columns,
    parsed,
    policy: auth.policy,
    allowedColumns: auth.allowedColumns,
  });
  const rows = await adapter.transaction((tx) => tx.execute(query));
  return jsonResponse({ status: HttpStatus.Ok, body: rows });
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

  const returning = parsed.select ?? auth.allowedColumns;
  ensureAllowed({ cols: returning, auth, relation });

  const { query, rowCount } = compileInsert({
    relation,
    columns,
    rows,
    insertColumns,
    policy: auth.policy,
    returning,
  });
  const inserted = await adapter.transaction(async (tx) => {
    const result = await tx.execute(query);
    if (result.length !== rowCount) {
      throw new ApiError({
        status: HttpStatus.Forbidden,
        message: `Insert into "${relation}" violates the WITH CHECK policy`,
      });
    }
    return result;
  });
  return jsonResponse({ status: HttpStatus.Created, body: inserted });
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
  ensureCatalog({ cols: parsed.filters.map((f) => f.column), columns, relation });

  const returning = parsed.select ?? auth.allowedColumns;
  ensureAllowed({ cols: returning, auth, relation });

  const plan = compileUpdate({
    relation,
    columns,
    body: patch,
    setColumns,
    parsed,
    policy: auth.policy,
    returning,
  });
  const updated = await adapter.transaction(async (tx) => {
    const result = (await tx.execute(plan.update)) as Row[];
    const ctids = result.map((r) => r[CTID_KEY]).filter((c): c is string => typeof c === 'string');
    if (ctids.length > 0) {
      const violations = await tx.execute(plan.verify(ctids));
      if (violations.length > 0) {
        throw new ApiError({
          status: HttpStatus.Forbidden,
          message: `Update on "${relation}" violates the WITH CHECK policy`,
        });
      }
    }
    for (const row of result) {
      delete row[CTID_KEY];
    }
    return result;
  });
  return jsonResponse({ status: HttpStatus.Ok, body: updated });
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
  ensureCatalog({ cols: parsed.filters.map((f) => f.column), columns, relation });

  const returning = parsed.select ?? auth.allowedColumns;
  ensureAllowed({ cols: returning, auth, relation });

  const query = compileDelete({
    relation,
    columns,
    parsed,
    policy: auth.policy,
    returning,
  });
  const rows = await adapter.transaction((tx) => tx.execute(query));
  return jsonResponse({ status: HttpStatus.Ok, body: rows });
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse({ status: err.status, body: { message: err.message } });
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith(PG_DATA_EXCEPTION_CLASS)) {
    const message = err instanceof Error ? err.message : 'Invalid request value';
    return jsonResponse({ status: HttpStatus.BadRequest, body: { message } });
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  return jsonResponse({ status: HttpStatus.InternalServerError, body: { message } });
}

export async function handleRequest({
  req,
  catalog,
  modules,
  adapter,
}: {
  req: Request;
  catalog: Catalog;
  modules: ReadonlyMap<string, RelationModule>;
  adapter: Adapter;
}): Promise<Response> {
  try {
    const op = METHOD_OP[req.method];
    if (op === undefined) {
      throw new ApiError({
        status: HttpStatus.MethodNotAllowed,
        message: `Method ${req.method} is not supported`,
      });
    }
    const url = new URL(req.url);
    const relation = relationNameFromUrl(url);
    const module = modules.get(relation);
    const columns = catalog[relation];
    if (module === undefined || columns === undefined) {
      throw new ApiError({
        status: HttpStatus.NotFound,
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
