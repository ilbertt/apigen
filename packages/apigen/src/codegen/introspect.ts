import type { PGlite } from '@electric-sql/pglite';

export interface IntrospectedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
}

/** relation name → its columns, in ordinal order. */
export type Introspection = Record<string, IntrospectedColumn[]>;

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
