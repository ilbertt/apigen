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
import {
  type Filter,
  type FunctionArgs,
  isFilterGroup,
  type JsonPathStep,
  type ParsedRequest,
  type Query,
  type RelationColumns,
  type SelectItem,
  type WhereNode,
} from './contract.js';
import { ApiError, HttpStatus } from './http.js';

const JSON_TYPES = new Set(['json', 'jsonb']);

const SCALAR_OP_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Full-text-search operator → the tsquery constructor it compiles against `@@`. */
const FTS_FN: Record<string, string> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
};

/**
 * Array/range operators: `col <symbol> value`, with the value cast to the column's
 * own type (the `{…}` array or `[…)` range literal from the URL binds straight to it).
 */
const SET_OP_SQL: Record<string, string> = {
  cs: '@>', // contains
  cd: '<@', // contained by
  ov: '&&', // overlaps
  sl: '<<', // strictly left of
  sr: '>>', // strictly right of
  nxr: '&<', // does not extend to the right of
  nxl: '&>', // does not extend to the left of
  adj: '-|-', // adjacent to
};

/** Operator symbol for an `op(any)`/`op(all)` quantifier: `col <symbol> any(array[…])`. */
const QUANT_OP_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
  match: '~',
  imatch: '~*',
};

/** Quantified operators whose array elements bind as text (patterns/regex), not the column type. */
const TEXT_QUANT_OPS = new Set(['like', 'ilike', 'match', 'imatch']);

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

/** `col -> 'a' ->> 'b'` — an integer key is an array index, anything else an object key. */
function jsonPathExpr({ base, path }: { base: Sql; path: readonly JsonPathStep[] }): Sql {
  let expr = base;
  for (const step of path) {
    const arrow = raw(step.arrow);
    const key = /^\d+$/.test(step.key) ? raw(step.key) : sql`${step.key}`;
    expr = sql`${expr} ${arrow} ${key}`;
  }
  return expr;
}

function projectItem({ item, columns }: { item: SelectItem; columns: RelationColumns }): Sql {
  pgTypeOf({ columns, col: item.column }); // presence check against the catalog
  const base = ident(item.column);
  // A plain column projects bare so json_agg labels it by its own name (byte-identical
  // to before). An alias, cast, or JSON path needs an explicit label for the JSON key.
  if (item.alias === undefined && item.cast === undefined && item.path === undefined) {
    return base;
  }
  const walked = item.path === undefined ? base : sql`(${jsonPathExpr({ base, path: item.path })})`;
  const expr = item.cast === undefined ? walked : sql`${walked}${castSuffix(item.cast)}`;
  // PostgREST names a JSON-path column after its last key unless explicitly aliased.
  const label = item.alias ?? item.path?.at(-1)?.key ?? item.column;
  return sql`${expr} as ${ident(label)}`;
}

function projection({
  items,
  columns,
}: {
  items: readonly SelectItem[];
  columns: RelationColumns;
}): Sql {
  if (items.length === 0) {
    internal('Relation has no visible columns to project');
  }
  // Project through Postgres' own JSON rendering (json_agg): numeric keeps its scale,
  // timestamptz serializes as ISO-8601, int8 as a number — byte-identical to PostgREST.
  return join({ values: items.map((item) => projectItem({ item, columns })), separator: ', ' });
}

/** A bare column list (no alias/cast) as select items — for the default "all columns". */
function toItems(cols: readonly string[]): SelectItem[] {
  return cols.map((column) => ({ column }));
}

function quantifiedCondition({
  filter,
  id,
  pgType,
}: {
  filter: Filter;
  id: Sql;
  pgType: string;
}): Sql {
  const symbol = raw(QUANT_OP_SQL[filter.op] as string);
  const quant = raw(filter.quantifier as string);
  const items = (filter.values ?? []).map((value) =>
    TEXT_QUANT_OPS.has(filter.op) ? sql`${value}::text` : castValue({ value, pgType }),
  );
  return sql`${id} ${symbol} ${quant}(array[${join({ values: items, separator: ', ' })}])`;
}

function filterCondition({ filter, id, pgType }: { filter: Filter; id: Sql; pgType: string }): Sql {
  if (filter.quantifier !== undefined) {
    return quantifiedCondition({ filter, id, pgType });
  }
  switch (filter.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return sql`${id} ${raw(SCALAR_OP_SQL[filter.op] as string)} ${castValue({ value: filter.value, pgType })}`;
    case 'isdistinct':
      return sql`${id} is distinct from ${castValue({ value: filter.value, pgType })}`;
    case 'like':
      return sql`${id} like ${filter.value}::text`;
    case 'ilike':
      return sql`${id} ilike ${filter.value}::text`;
    case 'match':
      return sql`${id} ~ ${filter.value}::text`;
    case 'imatch':
      return sql`${id} ~* ${filter.value}::text`;
    case 'fts':
    case 'plfts':
    case 'phfts':
    case 'wfts': {
      const fn = raw(FTS_FN[filter.op] as string);
      const tsquery =
        filter.config === undefined
          ? sql`${fn}(${filter.value}::text)`
          : sql`${fn}(${filter.config}::regconfig, ${filter.value}::text)`;
      return sql`${id} @@ ${tsquery}`;
    }
    case 'cs':
    case 'cd':
    case 'ov':
    case 'sl':
    case 'sr':
    case 'nxr':
    case 'nxl':
    case 'adj':
      return sql`${id} ${raw(SET_OP_SQL[filter.op] as string)} ${castValue({ value: filter.value, pgType })}`;
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

function filterFragment({ filter, columns }: { filter: Filter; columns: RelationColumns }): Sql {
  const id = ident(filter.column);
  const pgType = pgTypeOf({ columns, col: filter.column });
  const condition = filterCondition({ filter, id, pgType });
  return filter.negated ? sql`not (${condition})` : condition;
}

function nodeFragment({ node, columns }: { node: WhereNode; columns: RelationColumns }): Sql {
  if (!isFilterGroup(node)) {
    return filterFragment({ filter: node, columns });
  }
  const parts = node.children.map((child) => nodeFragment({ node: child, columns }));
  const grouped = sql`(${join({ values: parts, separator: node.op === 'or' ? ' or ' : ' and ' })})`;
  return node.negated ? sql`not ${grouped}` : grouped;
}

function whereClause({
  policy,
  filters,
  columns,
}: {
  policy: Policy;
  filters: readonly WhereNode[];
  columns: RelationColumns;
}): Sql {
  let clause = sql`where (${policy.fragment})`;
  for (const node of filters) {
    clause = sql`${clause} and ${nodeFragment({ node, columns })}`;
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

/**
 * A rendered result set: `body` is the JSON text Postgres produced, `page` the
 * number of rows on this page, `total` the full match count (only when a count was
 * requested). Every compiled statement returns exactly one row of this shape.
 */
export const RENDERED_KEYS = { body: 'body', page: 'page', total: 'total' } as const;

export function compileSelect({
  relation,
  columns,
  parsed,
  policy,
  allowedColumns,
  count = false,
}: {
  relation: string;
  columns: RelationColumns;
  parsed: ParsedRequest;
  policy: Policy;
  allowedColumns: readonly string[];
  count?: boolean;
}): Query {
  const items = parsed.select ?? toItems(allowedColumns);
  const parts: Sql[] = [
    sql`select ${projection({ items, columns })} from ${ident(relation)}`,
    whereClause({ policy, filters: parsed.filters, columns }),
    orderClause({ order: parsed.order, relation }),
  ];
  if (parsed.limit !== undefined) {
    parts.push(sql`limit ${parsed.limit}`);
  }
  if (parsed.offset !== undefined) {
    parts.push(sql`offset ${parsed.offset}`);
  }
  const page = assemble(parts);
  // `total` re-runs the filter without limit/offset — PostgREST's count=exact.
  const total = count
    ? sql`, (select count(*)::int from ${ident(relation)} ${whereClause({ policy, filters: parsed.filters, columns })}) as total`
    : empty;
  return toQuery(
    sql`select coalesce(json_agg(_apigen_rows), '[]')::text as body, count(*)::int as page${total} from (${page}) as _apigen_rows`,
  );
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
  returning: readonly SelectItem[];
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
  const stmt = sql`with _apigen_ins as (insert into ${ident(relation)} (${colList}) select ${colList} from (values ${values}) as v (${colList}) where (${policy.fragment}) returning ${projection({ items: returning, columns })}) select coalesce(json_agg(_apigen_ins), '[]')::text as body, count(*)::int as page from _apigen_ins`;
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
  returning: readonly SelectItem[];
}): UpdatePlan {
  const assignments = setColumns.map(
    (col) =>
      sql`${ident(col)} = ${castValue({ value: body[col] ?? null, pgType: pgTypeOf({ columns, col }) })}`,
  );
  const setClause = join({ values: assignments, separator: ', ' });
  const where = whereClause({ policy, filters: parsed.filters, columns });
  const ctid = raw(quoteIdent(CTID_KEY));
  const proj = projection({ items: returning, columns });
  // The re-select reads back the projected columns by their OUTPUT name (alias or
  // column), so an aliased/cast expression is applied once (in RETURNING), not twice.
  const outputCols = join({
    values: returning.map((item) => ident(item.alias ?? item.column)),
    separator: ', ',
  });
  // Aggregate the body from a subquery that projects only the returning columns —
  // json_agg over a record is compact (like row_to_json), matching PostgREST, and
  // keeps the ctid sentinel (used for WITH CHECK re-verification) out of the JSON.
  // ctids come back as a JSON text array (parsed in the handler) rather than a
  // Postgres text[]: a text[] is returned unparsed when the driver has
  // fetch_types disabled, whereas ::text is always a plain string.
  const update = sql`with _apigen_upd as (update ${ident(relation)} set ${setClause} ${where} returning ctid as ${ctid}, ${proj}) select coalesce((select json_agg(_apigen_rows) from (select ${outputCols} from _apigen_upd) _apigen_rows), '[]')::text as body, (select count(*)::int from _apigen_upd) as page, coalesce((select json_agg(${ctid}::text) from _apigen_upd), '[]')::text as ctids`;

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
  returning: readonly SelectItem[];
}): Query {
  const where = whereClause({ policy, filters: parsed.filters, columns });
  const stmt = sql`with _apigen_del as (delete from ${ident(relation)} ${where} returning ${projection({ items: returning, columns })}) select coalesce(json_agg(_apigen_del), '[]')::text as body, count(*)::int as page from _apigen_del`;
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
