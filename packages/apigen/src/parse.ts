import {
  FILTER_OPS,
  type Filter,
  type FilterOp,
  FTS_OPS,
  type OrderTerm,
  type ParsedRequest,
  QUANTIFIABLE_OPS,
} from './contract.js';
import { ApiError, HttpStatus } from './http.js';

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);
const FILTER_OP_SET = new Set<string>(FILTER_OPS);
const FTS_OP_SET = new Set<string>(FTS_OPS);
const QUANTIFIABLE_OP_SET = new Set<string>(QUANTIFIABLE_OPS);
/** The parenthetical in `op(x)` is either a full-text config or an any/all quantifier. */
const QUANTIFIERS = new Set(['any', 'all']);
/** `op` or `op(x)` followed by `.` — the parens tolerate dots (`pg_catalog.english`). */
const OP_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?\./;
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

function parseSelect(raw: string | null): readonly string[] | undefined {
  if (raw === null) {
    return undefined;
  }
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.includes('*')) {
    return undefined;
  }
  return tokens.map(assertColumn);
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

export function parseRequest(url: URL): ParsedRequest {
  const params = url.searchParams;
  const filters: Filter[] = [];
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) {
      continue;
    }
    filters.push(parseFilter({ column: assertColumn(key), raw }));
  }

  return {
    select: parseSelect(params.get('select')),
    filters,
    order: parseOrder(params.get('order')),
    limit: parseNonNegativeInt({ raw: params.get('limit'), name: 'limit' }),
    offset: parseNonNegativeInt({ raw: params.get('offset'), name: 'offset' }),
  };
}
