import { type RawValue, type Sql, sql } from './sql.js';

export type PolicyKind = 'using' | 'withCheck';

const POLICY_BRAND: unique symbol = Symbol('apigen.policy');

/**
 * A branded predicate fragment produced by `sql.using` / `sql.withCheck`. Users
 * never construct one by hand — the brand keeps arbitrary objects out of the
 * authorization return. `kind` selects the SQL clause: `using` → `USING`/`WHERE`,
 * `withCheck` → `WITH CHECK`.
 */
export interface Policy {
  readonly [POLICY_BRAND]: true;
  readonly kind: PolicyKind;
  readonly fragment: Sql;
}

export function isPolicy(value: unknown): value is Policy {
  return typeof value === 'object' && value !== null && POLICY_BRAND in value;
}

// biome-ignore lint/complexity/useMaxParams: tagged-template signature is fixed by the language.
export type PolicyTag = (strings: TemplateStringsArray, ...values: RawValue[]) => Policy;

function makeTag(kind: PolicyKind): PolicyTag {
  // biome-ignore lint/complexity/useMaxParams: tagged-template signature is fixed by the language.
  return (strings, ...values) => ({
    [POLICY_BRAND]: true,
    kind,
    fragment: sql(strings, ...values),
  });
}

/** Clause-builder bags handed to authorization functions, one shape per op. */
export interface UsingBag {
  readonly using: PolicyTag;
}
export interface WithCheckBag {
  readonly withCheck: PolicyTag;
}

export const usingBag: UsingBag = { using: makeTag('using') };
export const withCheckBag: WithCheckBag = { withCheck: makeTag('withCheck') };
