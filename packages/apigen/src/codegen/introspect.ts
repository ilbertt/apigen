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

/** Runs a read-only SQL string and returns the result rows. Any pg source fits. */
export type RunQuery = (sql: string) => Promise<unknown[]>;

/** Quote a schema name as a SQL string literal (single quotes doubled). */
const schemaLiteral = (schema: string): string => `'${schema.replaceAll("'", "''")}'`;

const columnsQuery = (schema: string): string => `
  select table_name, column_name, udt_name, is_nullable
  from information_schema.columns
  where table_schema = ${schemaLiteral(schema)}
  order by table_name, ordinal_position
`;

/**
 * IN/INOUT arguments of every function in `schema`, one row per argument (a no-arg
 * function still yields one row, with a null argument, via the LEFT JOIN).
 * Overloads share `routine_name` but differ by `specific_name`; we keep the first.
 */
const functionsQuery = (schema: string): string => `
  select
    r.routine_name as function_name,
    r.specific_name as specific_name,
    p.parameter_name as arg_name,
    p.udt_name as arg_type
  from information_schema.routines r
  left join information_schema.parameters p
    on p.specific_name = r.specific_name
    and p.parameter_mode in ('IN', 'INOUT')
  where r.routine_schema = ${schemaLiteral(schema)}
    and r.routine_type = 'FUNCTION'
    and r.data_type <> 'trigger'
  order by r.routine_name, r.specific_name, p.ordinal_position
`;

/** Primary-key columns of every table in `schema`, in key order. */
const primaryKeysQuery = (schema: string): string => `
  select tc.table_name, kcu.column_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name
    and kcu.table_schema = tc.table_schema
  where tc.constraint_type = 'PRIMARY KEY'
    and tc.table_schema = ${schemaLiteral(schema)}
  order by tc.table_name, kcu.ordinal_position
`;

interface ColumnRow {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: string;
}

interface PrimaryKeyRow {
  table_name: string;
  column_name: string;
}

/** relation → its primary-key column names, in key order. Tables without a PK are absent. */
export type PrimaryKeyIntrospection = Record<string, string[]>;

/** Every foreign key of every table in `schema`, one row per key column, in key order. */
const foreignKeysQuery = (schema: string): string => `
  select
    con.conname as constraint_name,
    cl.relname as from_table,
    att.attname as from_column,
    fcl.relname as to_table,
    fatt.attname as to_column
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  join pg_class fcl on fcl.oid = con.confrelid
  join pg_namespace ns on ns.oid = cl.relnamespace
  join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
  join lateral unnest(con.confkey) with ordinality as fk(attnum, ord) on fk.ord = k.ord
  join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
  join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = fk.attnum
  where con.contype = 'f' and ns.nspname = ${schemaLiteral(schema)}
  order by con.conname, k.ord
`;

interface ForeignKeyRow {
  constraint_name: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
}

/** A foreign key: local `columns` reference `foreignRelation.foreignColumns`. */
export interface IntrospectedForeignKey {
  columns: string[];
  foreignRelation: string;
  foreignColumns: string[];
}

/** relation → its outgoing foreign keys. Drives resource embedding. */
export type ForeignKeyIntrospection = Record<string, IntrospectedForeignKey[]>;

interface FunctionRow {
  function_name: string;
  specific_name: string;
  arg_name: string | null;
  arg_type: string | null;
}

export async function introspect({
  run,
  schema = 'public',
}: {
  run: RunQuery;
  schema?: string;
}): Promise<Introspection> {
  const rows = (await run(columnsQuery(schema))) as ColumnRow[];
  const relations: Introspection = {};
  for (const row of rows) {
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

export async function introspectPrimaryKeys({
  run,
  schema = 'public',
}: {
  run: RunQuery;
  schema?: string;
}): Promise<PrimaryKeyIntrospection> {
  const rows = (await run(primaryKeysQuery(schema))) as PrimaryKeyRow[];
  const keys: PrimaryKeyIntrospection = {};
  for (const row of rows) {
    const list = keys[row.table_name] ?? [];
    list.push(row.column_name);
    keys[row.table_name] = list;
  }
  return keys;
}

export async function introspectForeignKeys({
  run,
  schema = 'public',
}: {
  run: RunQuery;
  schema?: string;
}): Promise<ForeignKeyIntrospection> {
  const rows = (await run(foreignKeysQuery(schema))) as ForeignKeyRow[];
  const keys: ForeignKeyIntrospection = {};
  const byConstraint: Record<string, IntrospectedForeignKey> = {};
  for (const row of rows) {
    let fk = byConstraint[row.constraint_name];
    if (fk === undefined) {
      fk = { columns: [], foreignRelation: row.to_table, foreignColumns: [] };
      byConstraint[row.constraint_name] = fk;
      const list = keys[row.from_table] ?? [];
      list.push(fk);
      keys[row.from_table] = list;
    }
    fk.columns.push(row.from_column);
    fk.foreignColumns.push(row.to_column);
  }
  return keys;
}

export async function introspectFunctions({
  run,
  schema = 'public',
}: {
  run: RunQuery;
  schema?: string;
}): Promise<FunctionIntrospection> {
  const rows = (await run(functionsQuery(schema))) as FunctionRow[];
  const functions: FunctionIntrospection = {};
  const chosenOverload: Record<string, string> = {};
  for (const row of rows) {
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
