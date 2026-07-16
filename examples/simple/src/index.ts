/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, sql) by design. */

import { SQL } from 'bun';
import { Apigen, relation } from './api.gen.ts';

// Hard-coded for the example — point this at your Postgres.
const db = new SQL('postgres://postgres:postgres@localhost:5432/apigen');

// The "user" is whatever uuid the caller sends in x-owner-id. A real app resolves
// a session or token here (see the ecommerce examples); todos keeps auth to one
// line so the focus stays on the relation/policy patterns.
function ownerOf(req: Request): string | null {
  return req.headers.get('x-owner-id');
}

// A relation module registers one authorization fn per verb. Each returns a policy
// (compiled to USING / WITH CHECK) or `false` to deny (403). An *omitted* verb is
// denied too — here all four are present.
const todos = relation('todos')
  .select((req, sql) => {
    const owner = ownerOf(req);
    return owner ? { policy: sql.using`owner = ${owner}::uuid` } : false;
  })
  .insert((req, sql) => {
    const owner = ownerOf(req);
    return owner
      ? {
          // On writes, allowedColumns is the writable whitelist; any other column → 403.
          policy: sql.withCheck`owner = ${owner}::uuid`,
          allowedColumns: ['owner', 'title', 'done', 'priority', 'notes'],
        }
      : false;
  })
  .update((req, sql) => {
    const owner = ownerOf(req);
    return owner
      ? {
          policy: sql.using`owner = ${owner}::uuid`,
          allowedColumns: ['title', 'done', 'priority', 'notes'],
        }
      : false;
  })
  .delete((req, sql) => {
    const owner = ownerOf(req);
    return owner ? { policy: sql.using`owner = ${owner}::uuid` } : false;
  });

const app = new Apigen({ db }).use(todos);

const server = Bun.serve({ port: 3000, fetch: app.handle });
console.log(`listening on ${server.url}`);
