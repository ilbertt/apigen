import type { Adapter } from '../contract.js';

/**
 * Validate and brand a user-supplied execution-level adapter. This is the seam
 * for custom drivers (drizzle / kysely / pg); the built-in postgres.js/Bun.SQL
 * adapter is built with it too.
 */
export function createAdapter(adapter: Adapter): Adapter {
  if (typeof adapter.execute !== 'function' || typeof adapter.transaction !== 'function') {
    throw new TypeError('createAdapter requires an object with `execute` and `transaction`');
  }
  return adapter;
}
