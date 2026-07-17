import { resolveAdapter } from './adapters/resolve.js';
import type {
  Adapter,
  AnyOperationConfig,
  Catalog,
  DbInput,
  DeleteConfig,
  InsertConfig,
  Op,
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

export interface ApigenOptions {
  db: DbInput;
  catalog: Catalog;
}

/**
 * The app. `handle` is a bound `(Request) => Promise<Response>` — the WinterTC
 * entry point wired into any server (`Bun.serve({ fetch: app.handle })`). The
 * generated subclass bakes the catalog in so users write `new Apigen({ db })`.
 */
export class Apigen {
  readonly #adapter: Adapter;
  readonly #catalog: Catalog;
  readonly #modules = new Map<string, RelationModule>();

  constructor(options: ApigenOptions) {
    this.#adapter = resolveAdapter(options.db);
    this.#catalog = options.catalog;
  }

  use(relation: RelationModule): this {
    this.#modules.set(relation.name, relation);
    return this;
  }

  handle = (req: Request): Promise<Response> =>
    handleRequest({
      req,
      catalog: this.#catalog,
      modules: this.#modules,
      adapter: this.#adapter,
    });
}
