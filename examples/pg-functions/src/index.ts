import { SQL } from 'bun';
import { Apigen, func } from './api.gen.ts';

const db = new SQL('postgres://postgres:postgres@localhost:5432/apigen');

// Which callers may run privileged functions. A real app resolves a user; a header
// check keeps the example self-contained.
function isAdmin(req: Request): boolean {
  return req.headers.get('authorization') === 'Bearer admin-token';
}

const app = new Apigen({ db })
  // Public, pure functions — no authorization. `.execute({})` opts them in;
  // an unregistered function denies every call.
  .use(func('greet').execute({}))
  .use(func('search_articles').execute({}))
  .use(
    func('server_time').execute({
      afterExecute: ({ response }) => {
        response.headers.set('cache-control', 'no-store');
        return response;
      },
    }),
  )
  // Admin-only: a function's authorization is a coarse gate ("may this caller run
  // it"), which fits an all-or-nothing action like publishing.
  .use(
    func('publish_article').execute({
      authorization: (req) => isAdmin(req),
      beforeExecute: ({ functionName }) => {
        console.log(`admin invoked ${functionName}`);
      },
    }),
  );

const server = Bun.serve({ port: 3000, fetch: app.handle });
console.log(`listening on ${server.url}`);
