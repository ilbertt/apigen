import { raw, type Sql } from './sql.js';

const NUL = 0;

/**
 * Quote a single SQL identifier. Identifiers only ever come from the generated
 * catalog (request-named columns are checked against `allowedColumns` before they
 * reach here), so this is safe by construction — the quoting is defense in depth.
 */
export function quoteIdent(name: string): string {
  if (name.includes(String.fromCharCode(NUL))) {
    throw new Error('Identifier must not contain a NUL byte');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** A raw fragment for a quoted identifier — carries no bound params. */
export function ident(name: string): Sql {
  return raw(quoteIdent(name));
}
