import { resolveAdapter } from './adapters/resolve.js';
import type {
  Adapter,
  AnyOperationConfig,
  Catalog,
  DbInput,
  DeleteConfig,
  ForeignKeys,
  FunctionCatalog,
  FunctionConfig,
  FunctionModule,
  InsertConfig,
  Op,
  OpenApiOptions,
  PrimaryKeys,
  RelationModule,
  SchemaState,
  SelectConfig,
  UpdateConfig,
} from './contract.js';
import { handleRequest } from './handle.js';

/**
 * A `.use()`-able relation module. Each verb registers an {@link OperationConfig}
 * (`authorization` plus optional `beforeExecute`/`afterExecute` hooks) for that op;
 * an unregistered verb denies the op. `Col` names the relation's columns for
 * `allowedColumns` type-checking (bound by the generated `relation` factory).
 */
export class Relation<Col extends string = string> implements RelationModule {
  readonly name: string;
  /** The schema this relation is mounted under; `undefined` means the default schema. */
  readonly schema?: string;
  readonly handlers: Partial<Record<Op, AnyOperationConfig>> = {};

  constructor({ name, schema }: { name: string; schema?: string }) {
    this.name = name;
    this.schema = schema;
  }

  select(config: SelectConfig<Col>): this {
    this.handlers.select = config as AnyOperationConfig;
    return this;
  }

  insert(config: InsertConfig<Col>): this {
    this.handlers.insert = config as AnyOperationConfig;
    return this;
  }

  update(config: UpdateConfig<Col>): this {
    this.handlers.update = config as AnyOperationConfig;
    return this;
  }

  delete(config: DeleteConfig<Col>): this {
    this.handlers.delete = config as AnyOperationConfig;
    return this;
  }
}

/**
 * Create a relation module. Pass `{ schema }` to mount it under a non-default schema
 * (declared in {@link ApigenOptions.schemas}); clients then reach it by selecting that
 * schema per request via `Accept-Profile` (reads) / `Content-Profile` (writes).
 */
// biome-ignore lint/complexity/useMaxParams: public factory ergonomics — (name, options) is the intended shape.
export function relation<Col extends string = string>(
  name: string,
  options?: { schema?: string },
): Relation<Col> {
  return new Relation<Col>({ name, schema: options?.schema });
}

/**
 * A `.use()`-able function module. `.execute(config)` opts the function in and
 * registers its {@link FunctionConfig} (`authorization` plus optional hooks); an
 * unregistered function denies every call. A function call is `POST /rpc/<name>`.
 */
export class Func implements FunctionModule {
  readonly name: string;
  config?: FunctionConfig;

  constructor(name: string) {
    this.name = name;
  }

  execute(config: FunctionConfig = {}): this {
    this.config = config;
    return this;
  }
}

export function func(name: string): Func {
  return new Func(name);
}

/** The generated catalog and keys for one schema (the default schema's live at the top level). */
export interface SchemaCatalog {
  catalog: Catalog;
  primaryKeys?: PrimaryKeys;
  foreignKeys?: ForeignKeys;
}

export interface ApigenOptions {
  db: DbInput;
  catalog: Catalog;
  functions?: FunctionCatalog;
  primaryKeys?: PrimaryKeys;
  foreignKeys?: ForeignKeys;
  /** The default schema's name — used for `search_path` and the `Content-Profile` echo. Defaults to `'public'`. */
  defaultSchema?: string;
  /**
   * Additional exposed schemas beyond the default, each selected per request via
   * `Accept-Profile` (reads) / `Content-Profile` (writes). Mount their relations with
   * `relation('name', { schema: '<schema>' })`. Absent → a single-schema app.
   */
  schemas?: Record<string, SchemaCatalog>;
  /**
   * Provide this (even as `{}`) to expose the OpenAPI document at `GET /openapi`; its
   * fields override the document's `info` block. Omit it and `/openapi` is not served.
   */
  openapi?: OpenApiOptions;
}

/** Internal per-schema state; `modules` is mutated by `use()` (exposed read-only to the engine). */
interface SchemaSlot {
  readonly catalog: Catalog;
  readonly primaryKeys: PrimaryKeys;
  readonly foreignKeys: ForeignKeys;
  readonly modules: Map<string, RelationModule>;
}

/**
 * The app. `handle` is a bound `(Request) => Promise<Response>` — the WinterTC
 * entry point wired into any server (`Bun.serve({ fetch: app.handle })`). The
 * generated subclass bakes the catalog in so users write `new Apigen({ db })`.
 */
export class Apigen {
  readonly #adapter: Adapter;
  readonly #functionCatalog: FunctionCatalog;
  readonly #functions = new Map<string, FunctionModule>();
  readonly #defaultSchema: string;
  /** Exposed schema names in db-schemas order; index 0 is the default. */
  readonly #schemaOrder: readonly string[];
  readonly #multiSchema: boolean;
  readonly #schemas = new Map<string, SchemaSlot>();
  /** Present only when the caller opted into `/openapi`; `undefined` leaves it unexposed. */
  readonly #openapi: OpenApiOptions | undefined;

  constructor(options: ApigenOptions) {
    this.#adapter = resolveAdapter(options.db);
    this.#functionCatalog = options.functions ?? {};
    this.#openapi = options.openapi;
    this.#defaultSchema = options.defaultSchema ?? 'public';
    const extra = options.schemas ?? {};
    this.#multiSchema = Object.keys(extra).length > 0;
    this.#schemaOrder = [this.#defaultSchema, ...Object.keys(extra)];
    // The default schema comes from the top-level catalog/keys; the rest from `schemas`.
    const bundles: [string, SchemaCatalog][] = [
      [
        this.#defaultSchema,
        {
          catalog: options.catalog,
          primaryKeys: options.primaryKeys,
          foreignKeys: options.foreignKeys,
        },
      ],
      ...Object.entries(extra),
    ];
    for (const [name, bundle] of bundles) {
      this.#schemas.set(name, {
        catalog: bundle.catalog,
        primaryKeys: bundle.primaryKeys ?? {},
        foreignKeys: bundle.foreignKeys ?? {},
        modules: new Map(),
      });
    }
  }

  use(module: RelationModule | FunctionModule): this {
    if ('handlers' in module) {
      const schema = module.schema ?? this.#defaultSchema;
      const slot = this.#schemas.get(schema);
      if (slot === undefined) {
        throw new Error(
          `apigen: relation "${module.name}" is mounted in schema "${schema}", which is not declared in the "schemas" option`,
        );
      }
      slot.modules.set(module.name, module);
    } else {
      this.#functions.set(module.name, module);
    }
    return this;
  }

  handle = (req: Request): Promise<Response> =>
    handleRequest({
      req,
      schemas: this.#schemas as ReadonlyMap<string, SchemaState>,
      schemaOrder: this.#schemaOrder,
      defaultSchema: this.#defaultSchema,
      multiSchema: this.#multiSchema,
      openapi: this.#openapi,
      functionCatalog: this.#functionCatalog,
      functions: this.#functions,
      adapter: this.#adapter,
    });
}
