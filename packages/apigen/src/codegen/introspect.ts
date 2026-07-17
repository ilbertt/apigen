import type { PGlite } from '@electric-sql/pglite';

export interface IntrospectedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
}

/** relation name → its columns, in ordinal order. */
export type Introspection = Record<string, IntrospectedColumn[]>;

export interface IntrospectedArg {
  name: string;
  pgType: string;
}

/** A callable function's IN/INOUT arguments, in ordinal order. */
export interface IntrospectedFunction {
  name: string;
  args: IntrospectedArg[];
}

/** function name → its introspected signature. */
export type FunctionIntrospection = Record<string, IntrospectedFunction>;

const COLUMNS_QUERY = `
  select table_name, column_name, udt_name, is_nullable
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, ordinal_position
`;

/**
 * IN/INOUT arguments of every `public` function, one row per argument (a no-arg
 * function still yields one row, with a null argument, via the LEFT JOIN).
 * Overloads share `routine_name` but differ by `specific_name`; we keep the first.
 */
const FUNCTIONS_QUERY = `
  select
    r.routine_name as function_name,
    r.specific_name as specific_name,
    p.parameter_name as arg_name,
    p.udt_name as arg_type
  from information_schema.routines r
  left join information_schema.parameters p
    on p.specific_name = r.specific_name
    and p.parameter_mode in ('IN', 'INOUT')
  where r.routine_schema = 'public'
    and r.routine_type = 'FUNCTION'
    and r.data_type <> 'trigger'
  order by r.routine_name, r.specific_name, p.ordinal_position
`;

interface ColumnRow {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: string;
}

interface FunctionRow {
  function_name: string;
  specific_name: string;
  arg_name: string | null;
  arg_type: string | null;
}

export async function introspect(db: PGlite): Promise<Introspection> {
  const result = await db.query<ColumnRow>(COLUMNS_QUERY);
  const relations: Introspection = {};
  for (const row of result.rows) {
    const columns = relations[row.table_name] ?? [];
    relations[row.table_name] = columns;
    columns.push({
      name: row.column_name,
      pgType: row.udt_name,
      nullable: row.is_nullable === 'YES',
    });
  }
  return relations;
}

export async function introspectFunctions(db: PGlite): Promise<FunctionIntrospection> {
  const result = await db.query<FunctionRow>(FUNCTIONS_QUERY);
  const functions: FunctionIntrospection = {};
  const chosenOverload: Record<string, string> = {};
  for (const row of result.rows) {
    const existing = functions[row.function_name];
    if (existing === undefined) {
      functions[row.function_name] = { name: row.function_name, args: [] };
      chosenOverload[row.function_name] = row.specific_name;
    } else if (chosenOverload[row.function_name] !== row.specific_name) {
      continue;
    }
    // Unnamed arguments can't be bound by name — skip them (the function is still
    // exposed with whatever named arguments it declares).
    if (row.arg_name !== null && row.arg_type !== null) {
      functions[row.function_name]?.args.push({ name: row.arg_name, pgType: row.arg_type });
    }
  }
  return functions;
}
