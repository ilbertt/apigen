import {
  isPolicy,
  type Policy,
  type UsingBag,
  usingBag,
  type WithCheckBag,
  withCheckBag,
} from './builder/index.js';
import type { AuthContext, AuthResult, Op, RelationColumns, RelationModule } from './contract.js';
import { ApiError, HttpStatus } from './http.js';

export interface Authorization {
  readonly policy: Policy;
  /** Resolved whitelist: the grant's `allowedColumns`, or every catalog column. */
  readonly allowedColumns: readonly string[];
}

// biome-ignore lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design.
type AuthFnCall = (
  req: Request,
  ctx: AuthContext<UsingBag | WithCheckBag>,
) => AuthResult | Promise<AuthResult>;

function forbidden(message: string): never {
  throw new ApiError({ status: HttpStatus.Forbidden, message });
}

export async function authorize({
  req,
  op,
  module,
  columns,
}: {
  req: Request;
  op: Op;
  module: RelationModule;
  columns: RelationColumns;
}): Promise<Authorization> {
  const fn = module.handlers[op];
  if (!fn) {
    forbidden(`Operation "${op}" is not allowed on relation "${module.name}"`);
  }

  const bag = op === 'insert' ? withCheckBag : usingBag;
  const result = await (fn as AuthFnCall)(req, { sql: bag });
  if (result === false) {
    forbidden(`Denied "${op}" on relation "${module.name}"`);
  }
  if (!isPolicy(result.policy)) {
    throw new ApiError({
      status: HttpStatus.InternalServerError,
      message: `Authorization for "${module.name}" did not return an sql.using/sql.withCheck policy`,
    });
  }

  const allowedColumns = result.allowedColumns ?? Object.keys(columns);
  for (const col of allowedColumns) {
    if (!(col in columns)) {
      throw new ApiError({
        status: HttpStatus.InternalServerError,
        message: `allowedColumns names "${col}", which is not a column of "${module.name}"`,
      });
    }
  }
  return { policy: result.policy, allowedColumns };
}
