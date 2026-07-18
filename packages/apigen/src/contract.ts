import type { Policy, UsingBag, WithCheckBag } from './builder/index.js';

/** A composed statement: parameterized SQL text plus its bound values. */
export interface Query {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Execution-level database contract. apigen's currency is SQL text, not CRUD —
 * an adapter only needs to run a {@link Query} and open a transaction. `db` is
 * always a live instance the caller passes; apigen never opens a connection.
 */
export interface Adapter {
  execute(query: Query): Promise<unknown[]>;
  transaction<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>;
}

/**
 * A structural duck for postgres.js / Bun.SQL instances — loose on purpose so a
 * real client (whose `.unsafe`/`.begin` carry narrow, overloaded generics) is
 * assignable. The precise call signature lives inside the built-in adapter.
 */
export type PostgresLike = {
  unsafe: (...args: never[]) => unknown;
  begin: (...args: never[]) => unknown;
};

export type DbInput = Adapter | PostgresLike;

/** A Postgres type name as introspected into the catalog (e.g. `int8`, `uuid`). */
export type PgType = string;
export type RelationColumns = Record<string, PgType>;
/** The generated catalog: relation → column → pgType. Engine's only type source. */
export type Catalog = Record<string, RelationColumns>;

/** A callable function's named arguments → pgType, for casting the request's args. */
export type FunctionArgs = Record<string, PgType>;
/** The generated function catalog: function name → its argument types. */
export type FunctionCatalog = Record<string, FunctionArgs>;

export type Op = 'select' | 'insert' | 'update' | 'delete';

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is',
  'isdistinct',
  'like',
  'ilike',
  'match',
  'imatch',
  'fts',
  'plfts',
  'phfts',
  'wfts',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** The full-text-search operators; the only ones that accept an `op(config)` language. */
export const FTS_OPS = ['fts', 'plfts', 'phfts', 'wfts'] as const;

export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  /** Raw value from the URL for scalar/`like`/`is` ops. */
  readonly value: string;
  /** Present only for `in` — the parsed list members. */
  readonly values?: readonly string[];
  /** `not.` prefix — the whole condition is wrapped in SQL `NOT (…)`. */
  readonly negated?: boolean;
  /** Full-text-search language config from `op(config)`, e.g. `fts(english)`. */
  readonly config?: string;
}

export interface OrderTerm {
  readonly column: string;
  readonly ascending: boolean;
  readonly nullsFirst?: boolean;
}

/** PostgREST URL query parsed into structured form (parser → compiler contract). */
export interface ParsedRequest {
  /** Requested columns; `undefined` means "all visible columns". */
  readonly select?: readonly string[];
  readonly filters: readonly Filter[];
  readonly order: readonly OrderTerm[];
  readonly limit?: number;
  readonly offset?: number;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * Authorization result. `false` denies the op (→ 403). A grant carries the RLS
 * predicate plus the optional visible/writable column whitelist (names only —
 * casting types come from the catalog). Omitted `allowedColumns` → all columns.
 */
export interface AuthGrant<Col extends string = string> {
  readonly policy: Policy;
  readonly allowedColumns?: readonly Col[];
}
export type AuthResult<Col extends string = string> = false | AuthGrant<Col>;

/**
 * Second argument to an authorization fn: a context object exposing the
 * op-appropriate clause builder (`sql`). New fields may be added here over time,
 * so destructure what you need: `(req, { sql }) => …`.
 */
export interface AuthContext<Bag = UsingBag | WithCheckBag> {
  readonly sql: Bag;
}

// biome-ignore lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design.
type AuthFn<Bag, Col extends string> = (
  req: Request,
  ctx: AuthContext<Bag>,
) => MaybePromise<AuthResult<Col>>;

export type SelectAuthFn<Col extends string = string> = AuthFn<UsingBag, Col>;
export type DeleteAuthFn<Col extends string = string> = AuthFn<UsingBag, Col>;
export type UpdateAuthFn<Col extends string = string> = AuthFn<UsingBag, Col>;
export type InsertAuthFn<Col extends string = string> = AuthFn<WithCheckBag, Col>;

export type AnyAuthFn = SelectAuthFn | InsertAuthFn | UpdateAuthFn | DeleteAuthFn;

/** Lifecycle context passed to `beforeExecute`, before the query runs. */
export interface BeforeExecuteContext {
  readonly req: Request;
  readonly op: Op;
  readonly relation: string;
}

/** Lifecycle context passed to `afterExecute`: the built {@link Response} to modify or replace. */
export interface AfterExecuteContext {
  readonly req: Request;
  readonly op: Op;
  readonly relation: string;
  readonly response: Response;
}

/** Side-effect hook run once the op is routed, before the query — for logging/observability. */
export type BeforeExecute = (ctx: BeforeExecuteContext) => MaybePromise<void>;

/** Hook run on a successful response — return the (possibly modified) {@link Response}. */
export type AfterExecute = (ctx: AfterExecuteContext) => MaybePromise<Response>;

/**
 * Per-operation configuration. `authorization` is the policy fn; omit it to expose
 * the op publicly (`USING true`, all columns). `beforeExecute`/`afterExecute` are
 * optional lifecycle taps.
 */
export interface OperationConfig<Fn extends AnyAuthFn = AnyAuthFn> {
  readonly authorization?: Fn;
  readonly beforeExecute?: BeforeExecute;
  readonly afterExecute?: AfterExecute;
}

export type SelectConfig<Col extends string = string> = OperationConfig<SelectAuthFn<Col>>;
export type InsertConfig<Col extends string = string> = OperationConfig<InsertAuthFn<Col>>;
export type UpdateConfig<Col extends string = string> = OperationConfig<UpdateAuthFn<Col>>;
export type DeleteConfig<Col extends string = string> = OperationConfig<DeleteAuthFn<Col>>;

export type AnyOperationConfig = OperationConfig<AnyAuthFn>;

/** A mounted relation: its name plus the per-op configuration registered on it. */
export interface RelationModule {
  readonly name: string;
  readonly handlers: Readonly<Partial<Record<Op, AnyOperationConfig>>>;
}

/**
 * Authorization for a callable function. A function has no rows or columns, so the
 * gate is coarse: `true` allows the call, `false` denies it (→ 403). May be async.
 */
export type FunctionAuthFn = (req: Request) => MaybePromise<boolean>;

/** Lifecycle context passed to a function's `beforeExecute`, before the call runs. */
export interface FunctionExecuteContext {
  readonly req: Request;
  readonly functionName: string;
}

/** Lifecycle context passed to a function's `afterExecute`: the built {@link Response}. */
export interface FunctionResponseContext extends FunctionExecuteContext {
  readonly response: Response;
}

/** Side-effect hook run once a function call is routed, before it executes. */
export type FunctionBeforeExecute = (ctx: FunctionExecuteContext) => MaybePromise<void>;

/** Hook run on a successful function response — return the (possibly modified) {@link Response}. */
export type FunctionAfterExecute = (ctx: FunctionResponseContext) => MaybePromise<Response>;

/**
 * Configuration for an exposed function. `authorization` gates the call; omit it to
 * expose the function publicly. `beforeExecute`/`afterExecute` are optional taps.
 */
export interface FunctionConfig {
  readonly authorization?: FunctionAuthFn;
  readonly beforeExecute?: FunctionBeforeExecute;
  readonly afterExecute?: FunctionAfterExecute;
}

/**
 * A mounted function. `config` is registered by `.execute(...)`; while it is
 * `undefined` the function is not yet exposed and any call is denied.
 */
export interface FunctionModule {
  readonly name: string;
  readonly config?: Readonly<FunctionConfig>;
}
