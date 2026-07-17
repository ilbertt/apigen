import {
  empty,
  ident,
  join,
  type Policy,
  quoteIdent,
  raw,
  type Sql,
  sql,
} from './builder/index.js';
import type { Filter, FunctionArgs, ParsedRequest, Query, RelationColumns } from './contract.js';
import { ApiError, HttpStatus } from './http.js';

/** Types whose `int8`/`numeric`/temporal values we surface as strings via `::text`. */
const TEXT_CAST_TYPES = new Set([
  'int8',
  'numeric',
  'money',
  'timestamptz',
  'timestamp',
  'date',
  'time',
  'timetz',
  'interval',
]);

const JSON_TYPES = new Set(['json', 'jsonb']);

const SCALAR_OP_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

const CAST_TYPE_RE = /^[a-zA-Z0-9_]+$/;

/** RETURNING sentinel used only by update's WITH CHECK re-verification. */
export const CTID_KEY = '__apigen_ctid';

function internal(message: string): never {
  throw new ApiError({ status: HttpStatus.InternalServerError, message });
}

function toQuery(fragment: Sql): Query {
  return { text: fragment.text, values: fragment.values };
}

function pgTypeOf({ columns, col }: { columns: RelationColumns; col: string }): string {
  const pgType = columns[col];
  if (pgType === undefined) {
    internal(`Column "${col}" is not in the catalog`);
  }
  return pgType;
}

function castSuffix(pgType: string): Sql {
  if (!CAST_TYPE_RE.test(pgType)) {
    internal(`Unsafe catalog type "${pgType}"`);
  }
  return raw(`::${pgType}`);
}

function needsTextCast(pgType: string): boolean {
  return TEXT_CAST_TYPES.has(pgType);
}

function bindValue({ value, pgType }: { value: unknown; pgType: string }): unknown {
  if (JSON_TYPES.has(pgType) && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

/** A bound value with its column cast, e.g. `$1::int8`. */
function castValue({ value, pgType }: { value: unknown; pgType: string }): Sql {
  return sql`${bindValue({ value, pgType })}${castSuffix(pgType)}`;
}

function projectionColumn({ col, pgType }: { col: string; pgType: string }): Sql {
  const id = ident(col);
  return needsTextCast(pgType) ? sql`${id}::text as ${id}` : id;
}

function projection({ cols, columns }: { cols: readonly string[]; columns: RelationColumns }): Sql {
  if (cols.length === 0) {
    internal('Relation has no visible columns to project');
  }
  const frags = cols.map((col) => projectionColumn({ col, pgType: pgTypeOf({ columns, col }) }));
  return join({ values: frags, separator: ', ' });
}

function filterFragment({ filter, columns }: { filter: Filter; columns: RelationColumns }): Sql {
  const id = ident(filter.column);
  const pgType = pgTypeOf({ columns, col: filter.column });
  switch (filter.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return sql`${id} ${raw(SCALAR_OP_SQL[filter.op] as string)} ${castValue({ value: filter.value, pgType })}`;
    case 'like':
      return sql`${id} like ${filter.value}::text`;
    case 'ilike':
      return sql`${id} ilike ${filter.value}::text`;
    case 'is':
      return sql`${id} is ${raw(filter.value)}`;
    case 'in': {
      const values = filter.values ?? [];
      if (values.length === 0) {
        throw new ApiError({
          status: HttpStatus.BadRequest,
          message: '"in" list must not be empty',
        });
      }
      const items = values.map((value) => castValue({ value, pgType }));
      return sql`${id} in (${join({ values: items, separator: ', ' })})`;
    }
    default:
      return internal(`Unhandled filter operator "${filter.op as string}"`);
  }
}

function whereClause({
  policy,
  filters,
  columns,
}: {
  policy: Policy;
  filters: readonly Filter[];
  columns: RelationColumns;
}): Sql {
  let clause = sql`where (${policy.fragment})`;
  for (const filter of filters) {
    clause = sql`${clause} and ${filterFragment({ filter, columns })}`;
  }
  return clause;
}

function orderClause({
  order,
  relation,
}: {
  order: ParsedRequest['order'];
  relation: string;
}): Sql {
  if (order.length === 0) {
    return empty;
  }
  const table = ident(relation);
  const terms = order.map((term) => {
    const dir = raw(term.ascending ? 'asc' : 'desc');
    const nulls =
      term.nullsFirst === undefined ? empty : raw(term.nullsFirst ? 'nulls first' : 'nulls last');
    // Qualify with the table so ORDER BY resolves to the input column, not the
    // `::text`-aliased output column (which would sort numerics lexically).
    return sql`${table}.${ident(term.column)} ${dir} ${nulls}`;
  });
  return sql`order by ${join({ values: terms, separator: ', ' })}`;
}

function assemble(parts: readonly Sql[]): Sql {
  return join({ values: parts.filter((p) => p !== empty), separator: ' ' });
}

export function compileSelect({
  relation,
  columns,
  parsed,
  policy,
  allowedColumns,
}: {
  relation: string;
  columns: RelationColumns;
  parsed: ParsedRequest;
  policy: Policy;
  allowedColumns: readonly string[];
}): Query {
  const cols = parsed.select ?? allowedColumns;
  const parts: Sql[] = [
    sql`select ${projection({ cols, columns })} from ${ident(relation)}`,
    whereClause({ policy, filters: parsed.filters, columns }),
    orderClause({ order: parsed.order, relation }),
  ];
  if (parsed.limit !== undefined) {
    parts.push(sql`limit ${parsed.limit}`);
  }
  if (parsed.offset !== undefined) {
    parts.push(sql`offset ${parsed.offset}`);
  }
  return toQuery(assemble(parts));
}

export interface CompiledInsert {
  readonly query: Query;
  readonly rowCount: number;
}

export function compileInsert({
  relation,
  columns,
  rows,
  insertColumns,
  policy,
  returning,
}: {
  relation: string;
  columns: RelationColumns;
  rows: readonly Record<string, unknown>[];
  insertColumns: readonly string[];
  policy: Policy;
  returning: readonly string[];
}): CompiledInsert {
  const colList = join({ values: insertColumns.map(ident), separator: ', ' });
  const valueRows = rows.map((row) => {
    const cells = insertColumns.map((col) =>
      castValue({ value: row[col] ?? null, pgType: pgTypeOf({ columns, col }) }),
    );
    return sql`(${join({ values: cells, separator: ', ' })})`;
  });
  const values = join({ values: valueRows, separator: ', ' });
  // WITH CHECK is applied as a WHERE over the VALUES rows, so the policy can only
  // reference columns present in the request body — a column filled by a DB
  // default is not visible to the predicate here (PLAN's insert shape). Rows that
  // fail the predicate are filtered out; the caller rejects the batch on a count
  // mismatch.
  const stmt = sql`insert into ${ident(relation)} (${colList}) select ${colList} from (values ${values}) as v (${colList}) where (${policy.fragment}) returning ${projection({ cols: returning, columns })}`;
  return { query: toQuery(stmt), rowCount: rows.length };
}

export interface UpdatePlan {
  readonly update: Query;
  readonly verify: (ctids: readonly string[]) => Query;
}

export function compileUpdate({
  relation,
  columns,
  body,
  setColumns,
  parsed,
  policy,
  returning,
}: {
  relation: string;
  columns: RelationColumns;
  body: Record<string, unknown>;
  setColumns: readonly string[];
  parsed: ParsedRequest;
  policy: Policy;
  returning: readonly string[];
}): UpdatePlan {
  const assignments = setColumns.map(
    (col) =>
      sql`${ident(col)} = ${castValue({ value: body[col] ?? null, pgType: pgTypeOf({ columns, col }) })}`,
  );
  const setClause = join({ values: assignments, separator: ', ' });
  const where = whereClause({ policy, filters: parsed.filters, columns });
  const update = sql`update ${ident(relation)} set ${setClause} ${where} returning ctid as ${raw(quoteIdent(CTID_KEY))}, ${projection({ cols: returning, columns })}`;

  const verify = (ctids: readonly string[]): Query => {
    const tids = join({ values: ctids.map((c) => sql`${c}::tid`), separator: ', ' });
    return toQuery(
      sql`select 1 from ${ident(relation)} where ctid in (${tids}) and not (${policy.fragment}) limit 1`,
    );
  };

  return { update: toQuery(update), verify };
}

export function compileDelete({
  relation,
  columns,
  parsed,
  policy,
  returning,
}: {
  relation: string;
  columns: RelationColumns;
  parsed: ParsedRequest;
  policy: Policy;
  returning: readonly string[];
}): Query {
  const where = whereClause({ policy, filters: parsed.filters, columns });
  const stmt = sql`delete from ${ident(relation)} ${where} returning ${projection({ cols: returning, columns })}`;
  return toQuery(stmt);
}

function pgTypeOfArg({ args, arg }: { args: FunctionArgs; arg: string }): string {
  const pgType = args[arg];
  if (pgType === undefined) {
    internal(`Argument "${arg}" is not in the function catalog`);
  }
  return pgType;
}

/**
 * Compile a `POST /rpc/<name>` call. Each body key is bound with named-argument
 * notation (`"arg" := $n::type`) and cast to the argument's catalog type, so order
 * is irrelevant and omitted arguments fall back to the function's defaults. `select
 * *` uniformly surfaces scalar, composite, and set-returning results as rows.
 */
export function compileFunction({
  name,
  args,
  body,
}: {
  name: string;
  args: FunctionArgs;
  body: Record<string, unknown>;
}): Query {
  const provided = Object.keys(body);
  const namedArgs = provided.map(
    (arg) =>
      sql`${ident(arg)} := ${castValue({ value: body[arg] ?? null, pgType: pgTypeOfArg({ args, arg }) })}`,
  );
  const argList = namedArgs.length > 0 ? join({ values: namedArgs, separator: ', ' }) : empty;
  return toQuery(sql`select * from ${ident(name)}(${argList})`);
}
