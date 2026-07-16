/**
 * Map a Postgres `udt_name` to the TypeScript type used in generated row types.
 * `int8`/`numeric`/`money` are strings (they exceed JS number precision and the
 * engine surfaces them via `::text`); the rest keep their natural JS type.
 */
const TS_TYPES: Record<string, string> = {
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  float4: 'number',
  float8: 'number',
  oid: 'number',
  int8: 'string',
  numeric: 'string',
  money: 'string',
  json: 'unknown',
  jsonb: 'unknown',
};

export function tsTypeFor(pgType: string): string {
  return TS_TYPES[pgType] ?? 'string';
}
