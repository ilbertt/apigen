import {
  type EmbedItem,
  FILTER_OPS,
  type Filter,
  type FilterGroup,
  type FilterOp,
  FTS_OPS,
  isFilterGroup,
  type JsonPathStep,
  type OrderTerm,
  type ParsedRequest,
  QUANTIFIABLE_OPS,
  type SelectItem,
  type WhereNode,
} from './contract.js';
import { ApiError, HttpStatus } from './http.js';

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const FILTER_OP_SET = new Set<string>(FILTER_OPS);
const FTS_OP_SET = new Set<string>(FTS_OPS);
const QUANTIFIABLE_OP_SET = new Set<string>(QUANTIFIABLE_OPS);
/** The parenthetical in `op(x)` is either a full-text config or an any/all quantifier. */
const QUANTIFIERS = new Set(['any', 'all']);
/** `op` or `op(x)` followed by `.` — the parens tolerate dots (`pg_catalog.english`). */
const OP_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?\./;
/** A top-level `and`/`or`/`not.and`/`not.or` query-parameter key. */
const LOGICAL_KEY_RE = /^(not\.)?(and|or)$/;
/** A nested logical node inside a group: `and(…)` / `or(…)` / `not.and(…)` / `not.or(…)`. */
const NESTED_LOGICAL_RE = /^(not\.)?(and|or)\((.*)\)$/;
const IS_VALUES = new Set(['null', 'true', 'false', 'unknown']);
const COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function badRequest(message: string): never {
  throw new ApiError({ status: HttpStatus.BadRequest, message });
}

function assertColumn(name: string): string {
  if (!COLUMN_RE.test(name)) {
    badRequest(`Invalid column reference: "${name}"`);
  }
  return name;
}

const CAST_RE = /^[a-zA-Z0-9_]+$/;
const PATH_KEY_RE = /^[a-zA-Z0-9_]+$/;

/** Parse a `column[->a][->>b]` expression into its base column and JSON-path steps. */
function parsePath(expr: string): { column: string; path?: JsonPathStep[] } {
  const parts = expr.split(/(->>|->)/); // e.g. "meta->a->>b" → [meta, ->, a, ->>, b]
  const column = assertColumn(parts[0] ?? '');
  const path: JsonPathStep[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1] ?? '';
    if (!PATH_KEY_RE.test(key)) {
      badRequest(`Invalid JSON path key "${key}" in select`);
    }
    path.push({ arrow: parts[i] as '->' | '->>', key });
  }
  return path.length > 0 ? { column, path } : { column };
}

/** Parse one `select` token: `[alias:]column[->path][::type]`. */
function parseSelectItem(token: string): SelectItem {
  let rest = token;
  let cast: string | undefined;
  const castAt = rest.indexOf('::');
  if (castAt !== -1) {
    cast = rest.slice(castAt + 2);
    if (!CAST_RE.test(cast)) {
      badRequest(`Invalid cast type "${cast}" in select`);
    }
    rest = rest.slice(0, castAt);
  }
  let alias: string | undefined;
  const aliasAt = rest.indexOf(':');
  if (aliasAt !== -1) {
    alias = assertColumn(rest.slice(0, aliasAt));
    rest = rest.slice(aliasAt + 1);
  }
  const { column, path } = parsePath(rest);
  return {
    column,
    ...(alias !== undefined && { alias }),
    ...(cast !== undefined && { cast }),
    ...(path !== undefined && { path }),
  };
}

/** `[alias:]relation[!inner](nested)` — an embedded relation rather than a column. */
const EMBED_RE = /^(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)(!inner)?\((.*)\)$/;

function parseEmbed(match: RegExpExecArray): EmbedItem {
  const alias = match[1];
  const relation = assertColumn(match[2] ?? '');
  const inner = match[3] !== undefined;
  // Nested column projection; nested embeds are not yet supported and are ignored.
  const nested = parseSelect(match[4] ?? '');
  return {
    relation,
    ...(alias !== undefined && { alias }),
    ...(inner && { inner }),
    select: nested.columns,
  };
}

/**
 * Split `select` into column items and FK-embedded relations. A `*` (or absent select)
 * means all columns; explicit column tokens otherwise (possibly none, with only embeds).
 */
function parseSelect(raw: string | null): {
  columns?: readonly SelectItem[];
  embeds: readonly EmbedItem[];
} {
  if (raw === null) {
    return { embeds: [] };
  }
  const tokens = splitTopLevel(raw)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const columns: SelectItem[] = [];
  const embeds: EmbedItem[] = [];
  let star = tokens.length === 0;
  for (const token of tokens) {
    if (token === '*') {
      star = true;
      continue;
    }
    const embed = EMBED_RE.exec(token);
    if (embed !== null) {
      embeds.push(parseEmbed(embed));
    } else {
      columns.push(parseSelectItem(token));
    }
  }
  return { columns: star ? undefined : columns, embeds };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** PostgREST wildcard `*` maps to SQL `%`; a literal `%` passes through. */
function toLikePattern(value: string): string {
  return stripQuotes(value).replaceAll('*', '%');
}

function parseInList(rest: string): string[] {
  if (!(rest.startsWith('(') && rest.endsWith(')'))) {
    badRequest(`Expected "in" value to be a parenthesized list, got "${rest}"`);
  }
  const inner = rest.slice(1, -1);
  if (inner.trim().length === 0) {
    badRequest('"in" list must not be empty');
  }
  return inner.split(',').map((v) => stripQuotes(v.trim()));
}

/** The `{…}` operand of an any/all quantifier, each element transformed per operator. */
function parseQuantified({ op, rest }: { op: FilterOp; rest: string }): string[] {
  if (!(rest.startsWith('{') && rest.endsWith('}'))) {
    badRequest(`Expected a "{…}" array for the any/all quantifier, got "${rest}"`);
  }
  const inner = rest.slice(1, -1);
  if (inner.trim().length === 0) {
    badRequest('any/all array must not be empty');
  }
  const toElement = op === 'like' || op === 'ilike' ? toLikePattern : stripQuotes;
  return inner.split(',').map((v) => toElement(v.trim()));
}

const NOT_PREFIX = 'not.';

function parseOperand({
  column,
  op,
  rest,
}: {
  column: string;
  op: FilterOp;
  rest: string;
}): Filter {
  if (op === 'in') {
    return { column, op, value: rest, values: parseInList(rest) };
  }
  if (op === 'is') {
    const value = rest.toLowerCase();
    if (!IS_VALUES.has(value)) {
      badRequest(`"is" expects null/true/false/unknown, got "${rest}"`);
    }
    return { column, op, value };
  }
  if (op === 'like' || op === 'ilike') {
    return { column, op, value: toLikePattern(rest) };
  }
  if (FTS_OP_SET.has(op)) {
    // The tsquery is passed to to_tsquery/websearch_to_tsquery verbatim — quotes are
    // meaningful there (websearch phrases), so it is neither unquoted nor `*`-rewritten.
    return { column, op, value: rest };
  }
  // eq/neq/gt/gte/lt/lte/isdistinct/match/imatch: a single scalar operand. match
  // and imatch take a POSIX regex, so `*` is NOT rewritten to `%` (that is `like`).
  return { column, op, value: stripQuotes(rest) };
}

function parseFilter({ column, raw }: { column: string; raw: string }): Filter {
  const negated = raw.startsWith(NOT_PREFIX);
  const body = negated ? raw.slice(NOT_PREFIX.length) : raw;
  const match = OP_RE.exec(body);
  const opToken = match?.[1];
  if (match === null || opToken === undefined) {
    badRequest(`Filter "${column}=${raw}" must be "op.value"`);
  }
  const paren = match[2];
  const rest = body.slice(match[0]?.length ?? 0);
  if (!FILTER_OP_SET.has(opToken)) {
    badRequest(`Unsupported filter operator "${opToken}" on column "${column}"`);
  }
  const op = opToken as FilterOp;
  const operand = parseOperandWithParen({ column, op, rest, paren });
  return negated ? { ...operand, negated } : operand;
}

/** Resolve the `op(paren)` parenthetical into a quantifier, a full-text config, or nothing. */
function parseOperandWithParen({
  column,
  op,
  rest,
  paren,
}: {
  column: string;
  op: FilterOp;
  rest: string;
  paren: string | undefined;
}): Filter {
  if (paren === undefined) {
    return parseOperand({ column, op, rest });
  }
  if (QUANTIFIERS.has(paren)) {
    if (!QUANTIFIABLE_OP_SET.has(op)) {
      badRequest(`Operator "${op}" does not take an any/all quantifier`);
    }
    const values = parseQuantified({ op, rest });
    return { column, op, value: rest, values, quantifier: paren as 'any' | 'all' };
  }
  if (FTS_OP_SET.has(op)) {
    return { ...parseOperand({ column, op, rest }), config: paren };
  }
  badRequest(`Operator "${op}" does not take a "(${paren})"`);
}

/** Split on top-level commas only — commas nested in (), {} or [] stay put. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '{' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** A single condition inside a logical group: a nested group or a `column.op.value` filter. */
function parseNode(token: string): WhereNode {
  const nested = NESTED_LOGICAL_RE.exec(token);
  if (nested !== null) {
    return buildGroup({
      op: nested[2] as 'and' | 'or',
      negated: nested[1] !== undefined,
      inner: nested[3] ?? '',
    });
  }
  const dot = token.indexOf('.');
  if (dot === -1) {
    badRequest(`Condition "${token}" must be "column.operator.value"`);
  }
  return parseFilter({ column: assertColumn(token.slice(0, dot)), raw: token.slice(dot + 1) });
}

function buildGroup({
  op,
  negated,
  inner,
}: {
  op: 'and' | 'or';
  negated: boolean;
  inner: string;
}): FilterGroup {
  const tokens = splitTopLevel(inner)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    badRequest(`"${op}" must contain at least one condition`);
  }
  const children = tokens.map(parseNode);
  return negated ? { op, negated, children } : { op, children };
}

/** Parse a top-level `and=(…)` / `or=(…)` (optionally `not.`-prefixed) parameter. */
function parseTopLevelGroup({
  op,
  negated,
  raw,
}: {
  op: 'and' | 'or';
  negated: boolean;
  raw: string;
}): FilterGroup {
  if (!(raw.startsWith('(') && raw.endsWith(')'))) {
    badRequest(`"${op}" must be a parenthesized list, e.g. ${op}=(a.eq.1,b.eq.2)`);
  }
  return buildGroup({ op, negated, inner: raw.slice(1, -1) });
}

/** Every column referenced anywhere in the WHERE tree (for the authorization check). */
export function filterColumns(nodes: readonly WhereNode[]): string[] {
  const columns: string[] = [];
  for (const node of nodes) {
    if (isFilterGroup(node)) {
      columns.push(...filterColumns(node.children));
    } else {
      columns.push(node.column);
    }
  }
  return columns;
}

function parseOrder(raw: string | null): OrderTerm[] {
  if (raw === null) {
    return [];
  }
  const terms: OrderTerm[] = [];
  for (const part of raw.split(',')) {
    const tokens = part
      .trim()
      .split('.')
      .filter((t) => t.length > 0);
    const [column, ...modifiers] = tokens;
    if (column === undefined) {
      continue;
    }
    assertColumn(column);
    let ascending = true;
    let nullsFirst: boolean | undefined;
    for (const mod of modifiers) {
      if (mod === 'asc') {
        ascending = true;
      } else if (mod === 'desc') {
        ascending = false;
      } else if (mod === 'nullsfirst') {
        nullsFirst = true;
      } else if (mod === 'nullslast') {
        nullsFirst = false;
      } else {
        badRequest(`Invalid order modifier "${mod}" on column "${column}"`);
      }
    }
    terms.push({ column, ascending, nullsFirst });
  }
  return terms;
}

function parseNonNegativeInt({
  raw,
  name,
}: {
  raw: string | null;
  name: string;
}): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    badRequest(`"${name}" must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** Route a query-parameter key into a top-level condition (`and`/`or` group or a filter). */
function pushCondition({
  filters,
  key,
  raw,
}: {
  filters: WhereNode[];
  key: string;
  raw: string;
}): void {
  const logical = LOGICAL_KEY_RE.exec(key);
  if (logical !== null) {
    filters.push(
      parseTopLevelGroup({
        op: logical[2] as 'and' | 'or',
        negated: logical[1] !== undefined,
        raw,
      }),
    );
    return;
  }
  filters.push(parseFilter({ column: assertColumn(key), raw }));
}

/** Parse an embed's `<embed>.<param>` modifiers (filters/order/limit/offset). */
function parseEmbedParams(entries: readonly (readonly [string, string])[]): {
  filters: WhereNode[];
  order: OrderTerm[];
  limit?: number;
  offset?: number;
} {
  const filters: WhereNode[] = [];
  let order: OrderTerm[] = [];
  let limit: number | undefined;
  let offset: number | undefined;
  for (const [sub, raw] of entries) {
    if (sub === 'limit') {
      limit = parseNonNegativeInt({ raw, name: 'limit' });
    } else if (sub === 'offset') {
      offset = parseNonNegativeInt({ raw, name: 'offset' });
    } else if (sub === 'order') {
      order = parseOrder(raw);
    } else {
      pushCondition({ filters, key: sub, raw });
    }
  }
  return { filters, order, limit, offset };
}

export function parseRequest(url: URL): ParsedRequest {
  const params = url.searchParams;
  const { columns: selectColumns, embeds } = parseSelect(params.get('select'));
  const embedPrefixes = new Set(embeds.map((e) => e.alias ?? e.relation));

  const filters: WhereNode[] = [];
  const embedEntries = new Map<string, [string, string][]>();
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) {
      continue;
    }
    const dot = key.indexOf('.');
    const prefix = dot === -1 ? undefined : key.slice(0, dot);
    if (prefix !== undefined && embedPrefixes.has(prefix)) {
      const list = embedEntries.get(prefix) ?? [];
      list.push([key.slice(dot + 1), raw]);
      embedEntries.set(prefix, list);
      continue;
    }
    pushCondition({ filters, key, raw });
  }

  const enriched = embeds.map((embed) => {
    const entries = embedEntries.get(embed.alias ?? embed.relation);
    return entries === undefined ? embed : { ...embed, ...parseEmbedParams(entries) };
  });

  const columnList = (raw: string | null): readonly string[] | undefined =>
    raw
      ? raw
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .map(assertColumn)
      : undefined;

  return {
    select: selectColumns,
    embed: enriched.length > 0 ? enriched : undefined,
    filters,
    order: parseOrder(params.get('order')),
    limit: parseNonNegativeInt({ raw: params.get('limit'), name: 'limit' }),
    offset: parseNonNegativeInt({ raw: params.get('offset'), name: 'offset' }),
    onConflict: columnList(params.get('on_conflict')),
    columns: columnList(params.get('columns')),
  };
}
