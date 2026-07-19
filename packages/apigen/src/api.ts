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
  PrimaryKeys,
  RelationModule,
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
  readonly handlers: Partial<Record<Op, AnyOperationConfig>> = {};

  constructor(name: string) {
    this.name = name;
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

export function relation<Col extends string = string>(name: string): Relation<Col> {
  return new Relation<Col>(name);
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

export interface ApigenOptions {
  db: DbInput;
  catalog: Catalog;
  functions?: FunctionCatalog;
  primaryKeys?: PrimaryKeys;
  foreignKeys?: ForeignKeys;
}

/**
 * The app. `handle` is a bound `(Request) => Promise<Response>` — the WinterTC
 * entry point wired into any server (`Bun.serve({ fetch: app.handle })`). The
 * generated subclass bakes the catalog in so users write `new Apigen({ db })`.
 */
export class Apigen {
  readonly #adapter: Adapter;
  readonly #catalog: Catalog;
  readonly #primaryKeys: PrimaryKeys;
  readonly #foreignKeys: ForeignKeys;
  readonly #functionCatalog: FunctionCatalog;
  readonly #modules = new Map<string, RelationModule>();
  readonly #functions = new Map<string, FunctionModule>();

  constructor(options: ApigenOptions) {
    this.#adapter = resolveAdapter(options.db);
    this.#catalog = options.catalog;
    this.#primaryKeys = options.primaryKeys ?? {};
    this.#foreignKeys = options.foreignKeys ?? {};
    this.#functionCatalog = options.functions ?? {};
  }

  use(module: RelationModule | FunctionModule): this {
    if ('handlers' in module) {
      this.#modules.set(module.name, module);
    } else {
      this.#functions.set(module.name, module);
    }
    return this;
  }

  handle = (req: Request): Promise<Response> =>
    handleRequest({
      req,
      catalog: this.#catalog,
      primaryKeys: this.#primaryKeys,
      foreignKeys: this.#foreignKeys,
      functionCatalog: this.#functionCatalog,
      modules: this.#modules,
      functions: this.#functions,
      adapter: this.#adapter,
    });
}
