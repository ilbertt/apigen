import { resolveAdapter } from './adapters/resolve.js';
import type {
  Adapter,
  AnyAuthFn,
  Catalog,
  DbInput,
  DeleteAuthFn,
  InsertAuthFn,
  Op,
  RelationModule,
  SelectAuthFn,
  UpdateAuthFn,
} from './contract.js';
import { handleRequest } from './handle.js';

/**
 * A `.use()`-able relation module. Each verb registers the authorization fn for
 * that op; an omitted verb denies the op. `Col` names the relation's columns for
 * `allowedColumns` type-checking (bound by the generated `relation` factory).
 */
export class Relation<Col extends string = string> implements RelationModule {
  readonly name: string;
  readonly handlers: Partial<Record<Op, AnyAuthFn>> = {};

  constructor(name: string) {
    this.name = name;
  }

  select(fn: SelectAuthFn<Col>): this {
    this.handlers.select = fn as AnyAuthFn;
    return this;
  }

  insert(fn: InsertAuthFn<Col>): this {
    this.handlers.insert = fn as AnyAuthFn;
    return this;
  }

  update(fn: UpdateAuthFn<Col>): this {
    this.handlers.update = fn as AnyAuthFn;
    return this;
  }

  delete(fn: DeleteAuthFn<Col>): this {
    this.handlers.delete = fn as AnyAuthFn;
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
