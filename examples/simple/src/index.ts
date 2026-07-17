/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { SQL } from 'bun';
import { Apigen, relation } from './api.gen.ts';

const db = new SQL('postgres://postgres:postgres@localhost:5432/apigen');

function ownerOf(req: Request): string | null {
  return req.headers.get('x-owner-id');
}

const todos = relation('todos')
  .select((req, { sql }) => {
    const owner = ownerOf(req);
    if (!owner) {
      return false;
    }
    return { policy: sql.using`owner = ${owner}::uuid` };
  })
  .insert((req, { sql }) => {
    const owner = ownerOf(req);
    if (!owner) {
      return false;
    }
    return {
      policy: sql.withCheck`owner = ${owner}::uuid`,
      allowedColumns: ['owner', 'title', 'done', 'priority', 'notes'],
    };
  })
  .update((req, { sql }) => {
    const owner = ownerOf(req);
    if (!owner) {
      return false;
    }
    return {
      policy: sql.using`owner = ${owner}::uuid`,
      allowedColumns: ['title', 'done', 'priority', 'notes'],
    };
  })
  .delete((req, { sql }) => {
    const owner = ownerOf(req);
    if (!owner) {
      return false;
    }
    return { policy: sql.using`owner = ${owner}::uuid` };
  });

const app = new Apigen({ db }).use(todos);

const server = Bun.serve({ port: 3000, fetch: app.handle });
console.log(`listening on ${server.url}`);
