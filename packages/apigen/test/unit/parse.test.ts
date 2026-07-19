import { expect, test } from 'bun:test';
import type { Filter, OrderTerm } from '../../src/contract.js';
import { ApiError, HttpStatus } from '../../src/http.js';
import { parseRequest } from '../../src/parse.js';

function urlFor(query: string): URL {
  return new URL(`http://localhost/orders?${query}`);
}

function expectBadRequest(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).status).toBe(HttpStatus.BadRequest);
}

test('select: comma-separated columns become a column list', () => {
  expect(parseRequest(urlFor('select=customer,amount')).select).toEqual(['customer', 'amount']);
});

test('select: "*" and an absent select both mean "all columns" (undefined)', () => {
  expect(parseRequest(urlFor('select=*')).select).toBeUndefined();
  expect(parseRequest(urlFor('')).select).toBeUndefined();
});

const FILTER_CASES: readonly { readonly query: string; readonly expected: Filter }[] = [
  { query: 'amount=eq.100', expected: { column: 'amount', op: 'eq', value: '100' } },
  { query: 'amount=neq.100', expected: { column: 'amount', op: 'neq', value: '100' } },
  { query: 'amount=gt.100', expected: { column: 'amount', op: 'gt', value: '100' } },
  { query: 'amount=gte.100', expected: { column: 'amount', op: 'gte', value: '100' } },
  { query: 'amount=lt.100', expected: { column: 'amount', op: 'lt', value: '100' } },
  { query: 'amount=lte.100', expected: { column: 'amount', op: 'lte', value: '100' } },
  {
    query: 'customer=in.(Alice,Bob,Carol)',
    expected: {
      column: 'customer',
      op: 'in',
      value: '(Alice,Bob,Carol)',
      values: ['Alice', 'Bob', 'Carol'],
    },
  },
  { query: 'paid=is.null', expected: { column: 'paid', op: 'is', value: 'null' } },
  { query: 'paid=is.TRUE', expected: { column: 'paid', op: 'is', value: 'true' } },
  { query: 'customer=like.*Bob*', expected: { column: 'customer', op: 'like', value: '%Bob%' } },
  { query: 'customer=ilike.*bob*', expected: { column: 'customer', op: 'ilike', value: '%bob%' } },
  // match/imatch take a POSIX regex verbatim — `*` stays `*`, unlike like/ilike.
  {
    query: 'customer=match.^A.*e$',
    expected: { column: 'customer', op: 'match', value: '^A.*e$' },
  },
  { query: 'customer=imatch.^a', expected: { column: 'customer', op: 'imatch', value: '^a' } },
  { query: 'note=isdistinct.vip', expected: { column: 'note', op: 'isdistinct', value: 'vip' } },
  // not. prefix sets `negated`; the operator underneath parses exactly as it would bare.
  {
    query: 'customer=not.eq.Alice',
    expected: { column: 'customer', op: 'eq', value: 'Alice', negated: true },
  },
  {
    query: 'paid=not.is.null',
    expected: { column: 'paid', op: 'is', value: 'null', negated: true },
  },
  {
    query: 'customer=not.in.(Alice,Bob)',
    expected: {
      column: 'customer',
      op: 'in',
      value: '(Alice,Bob)',
      values: ['Alice', 'Bob'],
      negated: true,
    },
  },
  {
    query: 'customer=not.like.A*',
    expected: { column: 'customer', op: 'like', value: 'A%', negated: true },
  },
  // full-text search: value is verbatim; `op(config)` carries the language.
  { query: 'description=fts.red', expected: { column: 'description', op: 'fts', value: 'red' } },
  {
    query: 'description=fts(english).red',
    expected: { column: 'description', op: 'fts', value: 'red', config: 'english' },
  },
  {
    query: 'description=plfts.blue',
    expected: { column: 'description', op: 'plfts', value: 'blue' },
  },
  {
    query: 'description=phfts.red',
    expected: { column: 'description', op: 'phfts', value: 'red' },
  },
  { query: 'description=wfts.car', expected: { column: 'description', op: 'wfts', value: 'car' } },
  {
    query: 'description=not.wfts.car',
    expected: { column: 'description', op: 'wfts', value: 'car', negated: true },
  },
];

for (const { query, expected } of FILTER_CASES) {
  test(`filter operator "${expected.op}" parses "${query}"`, () => {
    expect(parseRequest(urlFor(query)).filters).toEqual([expected]);
  });
}

test('order: desc plus a nullslast modifier', () => {
  const terms = parseRequest(urlFor('order=amount.desc.nullslast')).order;
  expect(terms).toEqual([{ column: 'amount', ascending: false, nullsFirst: false }]);
});

test('order: asc plus a nullsfirst modifier', () => {
  const terms = parseRequest(urlFor('order=amount.asc.nullsfirst')).order;
  expect(terms).toEqual([{ column: 'amount', ascending: true, nullsFirst: true }]);
});

test('order: a bare column defaults to ascending with no nulls modifier', () => {
  const terms = parseRequest(urlFor('order=customer')).order;
  expect(terms).toEqual([{ column: 'customer', ascending: true, nullsFirst: undefined }]);
});

test('order: multiple comma-separated terms preserve their order', () => {
  const terms = parseRequest(urlFor('order=customer.asc,amount.desc.nullsfirst')).order;
  const expected: OrderTerm[] = [
    { column: 'customer', ascending: true, nullsFirst: undefined },
    { column: 'amount', ascending: false, nullsFirst: true },
  ];
  expect(terms).toEqual(expected);
});

test('no order param yields an empty array', () => {
  expect(parseRequest(urlFor('')).order).toEqual([]);
});

const LIMIT = 5;
const OFFSET = 3;

test('limit and offset parse as numbers', () => {
  const parsed = parseRequest(urlFor(`limit=${LIMIT}&offset=${OFFSET}`));
  expect(parsed.limit).toBe(LIMIT);
  expect(parsed.offset).toBe(OFFSET);
});

test('limit and offset are undefined when absent', () => {
  const parsed = parseRequest(urlFor(''));
  expect(parsed.limit).toBeUndefined();
  expect(parsed.offset).toBeUndefined();
});

test('a negative limit is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('limit=-1')));
});

test('a non-numeric limit is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('limit=abc')));
});

test('a negative offset is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('offset=-1')));
});

test('an unknown filter operator is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('status=frobnicate.1')));
});

test('a "(config)" on a non-full-text operator is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('amount=eq(english).1')));
});

test('an empty "in" list is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('customer=in.()')));
});

test('a filter missing the "op.value" shape is a 400', () => {
  expectBadRequest(() => parseRequest(urlFor('status=paid')));
});
