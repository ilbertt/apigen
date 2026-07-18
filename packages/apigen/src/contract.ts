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

/** Generated primary-key catalog: relation → its PK column names, in key order. */
export type PrimaryKeys = Record<string, readonly string[]>;

/** A foreign key: local `columns` reference `foreignRelation.foreignColumns`. */
export interface ForeignKey {
  readonly columns: readonly string[];
  readonly foreignRelation: string;
  readonly foreignColumns: readonly string[];
}

/** Generated foreign-key catalog: relation → its outgoing FKs. Drives resource embedding. */
export type ForeignKeys = Record<string, readonly ForeignKey[]>;

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
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
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
  /** `op(any)`/`op(all)` quantifier — the operator is applied against `values` as an array. */
  readonly quantifier?: 'any' | 'all';
}

/** Operators that accept an `op(any)`/`op(all)` quantifier over a `{…}` value list. */
export const QUANTIFIABLE_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'match',
  'imatch',
] as const;

/** A logical grouping of conditions: `and=(…)` / `or=(…)`, optionally `not.`-negated. */
export interface FilterGroup {
  readonly op: 'and' | 'or';
  readonly negated?: boolean;
  readonly children: readonly WhereNode[];
}

/** A node in the WHERE tree: a leaf {@link Filter} or a nested {@link FilterGroup}. */
export type WhereNode = Filter | FilterGroup;

/** Narrow a {@link WhereNode} to a {@link FilterGroup}. */
export function isFilterGroup(node: WhereNode): node is FilterGroup {
  return 'children' in node;
}

export interface OrderTerm {
  readonly column: string;
  readonly ascending: boolean;
  readonly nullsFirst?: boolean;
}

/** One step of a JSON path: `->` yields json, `->>` yields text; `key` is an object key or array index. */
export interface JsonPathStep {
  readonly arrow: '->' | '->>';
  readonly key: string;
}

/**
 * A projected column: the source `column`, an optional JSON `path` into it
 * (`col->a->>b`), optionally renamed (`alias:col`) and/or cast (`col::type`). A plain
 * column has none of these.
 */
/** Aggregate functions PostgREST allows in `select` (when db-aggregates is enabled). */
export const AGGREGATES = ['sum', 'avg', 'count', 'max', 'min'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export interface SelectItem {
  readonly column: string;
  readonly alias?: string;
  readonly cast?: string;
  readonly path?: readonly JsonPathStep[];
  /** An aggregate over `column`, e.g. `amount.sum()`; `count()` has an empty `column`. */
  readonly aggregate?: Aggregate;
}

/** An embedded relation in `select`, e.g. `order_items(id,sku)` — a FK-based nested resource. */
export interface EmbedItem {
  readonly relation: string;
  readonly alias?: string;
  /** The embedded projection; `undefined` means all of the embedded relation's columns. */
  readonly select?: readonly SelectItem[];
  /** `!inner` — an inner join: base rows without a matching embed are dropped. */
  readonly inner?: boolean;
  /** `...table` — spread: flatten the (to-one) embedded columns into the base row. */
  readonly spread?: boolean;
  /** Modifiers scoped to this embed via `<embed>.<param>` (filters/order/limit/offset). */
  readonly filters?: readonly WhereNode[];
  readonly order?: readonly OrderTerm[];
  readonly limit?: number;
  readonly offset?: number;
  /** Nested embeds inside this one, e.g. `orders(order_items(sku))`. */
  readonly embed?: readonly EmbedItem[];
}

/** PostgREST URL query parsed into structured form (parser → compiler contract). */
export interface ParsedRequest {
  /** Requested columns; `undefined` means "all visible columns". */
  readonly select?: readonly SelectItem[];
  /** FK-embedded relations requested in `select`, e.g. `order_items(*)`. */
  readonly embed?: readonly EmbedItem[];
  /** Top-level conditions, implicitly AND-ed together (a `WhereNode` may be a group). */
  readonly filters: readonly WhereNode[];
  readonly order: readonly OrderTerm[];
  readonly limit?: number;
  readonly offset?: number;
  /** `on_conflict` columns — the upsert conflict target; defaults to the primary key. */
  readonly onConflict?: readonly string[];
  /** `columns` — the explicit insert column set (body keys outside it are ignored). */
  readonly columns?: readonly string[];
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
  /** The schema this relation belongs to; omitted means the default schema. */
  readonly schema?: string;
  readonly handlers: Readonly<Partial<Record<Op, AnyOperationConfig>>>;
}

/**
 * Overrides for the `info` block of the OpenAPI document served at `/openapi`. All are
 * optional: `title`/`description` fall back to sensible defaults, and `version` is
 * omitted from the document entirely when unset — apigen can't reliably know its own
 * version at runtime (its files may be relocated or bundled), so the caller supplies it.
 */
export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
}

/**
 * Everything the engine needs to serve one schema: its generated catalog/keys and
 * the relation modules mounted under it. A single-schema app has exactly one of these
 * (the default schema); multi-schema apps have one per exposed schema, selected per
 * request via `Accept-Profile` (reads) / `Content-Profile` (writes).
 */
export interface SchemaState {
  readonly catalog: Catalog;
  readonly primaryKeys: PrimaryKeys;
  readonly foreignKeys: ForeignKeys;
  readonly modules: ReadonlyMap<string, RelationModule>;
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
