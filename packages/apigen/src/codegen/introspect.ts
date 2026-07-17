export interface IntrospectedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
}

/** relation name → its columns, in ordinal order. */
export type Introspection = Record<string, IntrospectedColumn[]>;

/** Runs a read-only SQL string and returns the result rows. Any pg source fits. */
export type RunQuery = (sql: string) => Promise<unknown[]>;

const COLUMNS_QUERY = `
  select table_name, column_name, udt_name, is_nullable
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, ordinal_position
`;

interface ColumnRow {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: string;
}

export async function introspect(run: RunQuery): Promise<Introspection> {
  const rows = (await run(COLUMNS_QUERY)) as ColumnRow[];
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
