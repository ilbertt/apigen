import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { generateFromSql } from '../src/codegen/generate.js';
import type { FunctionCatalog } from '../src/contract.js';
import { Apigen, func } from '../src/index.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const MIGRATIONS = `
  create table todos (
    id bigint generated always as identity primary key,
    owner uuid not null,
    title text not null,
    done boolean not null default false
  );

  create function add_numbers(a integer, b integer) returns integer
    language sql immutable as $$ select a + b $$;

  create function greet(name text, excited boolean default false) returns text
    language sql immutable as $$
      select 'Hello, ' || name || case when excited then '!' else '.' end
    $$;

  create function whoami() returns text
    language sql stable as $$ select 'anon'::text $$;

  create function count_todos(owner_id uuid) returns bigint
    language sql stable as $$ select count(*) from todos where owner = owner_id $$;

  create function series(n integer) returns setof integer
    language sql immutable as $$ select generate_series(1, n) $$;
`;

const OWNER = '11111111-1111-1111-1111-111111111111';
const SEED = `
  insert into todos (owner, title, done) values
    ('${OWNER}', 'a', false),
    ('${OWNER}', 'b', true);
`;

/** Hand-written catalog for the base-runtime gate/routing tests (no codegen). */
const FUNCTIONS: FunctionCatalog = {
  add_numbers: { a: 'int4', b: 'int4' },
  greet: { name: 'text', excited: 'bool' },
  whoami: {},
};

const GENERATED_PATH = join(import.meta.dir, '__generated__', 'functions.gen.ts');

let source: string;
let db: TestDb;

beforeAll(async () => {
  source = await generateFromSql({ migrations: MIGRATIONS, moduleSpecifier: '@repo/apigen' });
  await Bun.write(GENERATED_PATH, source);
  db = await createTestDb({ migrations: MIGRATIONS, seed: SEED });
});

afterAll(async () => {
  // Keep test/__generated__/functions.gen.ts around so `tsc` typechecks the emitted output.
  await db.end();
});

function post({ name, args }: { name: string; args?: unknown }): Request {
  return new Request(`http://localhost/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: args === undefined ? undefined : JSON.stringify(args),
  });
}

test('functions catalog maps argument names to pgTypes; no-arg function is empty', () => {
  expect(source).toContain('export const functions = {');
  expect(source).toContain('add_numbers: {');
  expect(source).toContain("a: 'int4',");
  expect(source).toContain("b: 'int4',");
  expect(source).toContain('greet: {');
  expect(source).toContain("name: 'text',");
  expect(source).toContain("excited: 'bool',");
  expect(source).toContain('whoami: {},');
  expect(source).toContain('export type Functions = typeof functions;');
});

test('emits a catalog-bound func factory and passes functions into Apigen', () => {
  expect(source).toContain('export function func<F extends keyof Functions & string>');
  expect(source).toContain('super({ db: options.db, catalog, functions });');
});

test('generated module: rpc returns scalar, defaulted-arg, no-arg, and set-returning rows', async () => {
  const gen = (await import(GENERATED_PATH)) as typeof import('./__generated__/functions.gen.ts');
  const app = new gen.Apigen({ db: db.sql })
    .use(gen.func('add_numbers').execute({}))
    .use(gen.func('greet').execute({}))
    .use(gen.func('whoami').execute({}))
    .use(gen.func('count_todos').execute({}))
    .use(gen.func('series').execute({}));

  const add = await app.handle(post({ name: 'add_numbers', args: { a: 2, b: 3 } }));
  expect(add.status).toBe(200);
  expect(await add.json()).toEqual([{ add_numbers: 5 }]);

  // `excited` is omitted → the function's default (false) applies.
  const greet = await app.handle(post({ name: 'greet', args: { name: 'World' } }));
  expect(await greet.json()).toEqual([{ greet: 'Hello, World.' }]);

  const excited = await app.handle(post({ name: 'greet', args: { name: 'World', excited: true } }));
  expect(await excited.json()).toEqual([{ greet: 'Hello, World!' }]);

  const who = await app.handle(post({ name: 'whoami' }));
  expect(await who.json()).toEqual([{ whoami: 'anon' }]);

  // int8 result surfaces as a string, like a relation column.
  const count = await app.handle(post({ name: 'count_todos', args: { owner_id: OWNER } }));
  expect(await count.json()).toEqual([{ count_todos: '2' }]);

  // `select *` over a set-returning function yields one row per element.
  const series = await app.handle(post({ name: 'series', args: { n: 3 } }));
  expect(await series.json()).toEqual([{ series: 1 }, { series: 2 }, { series: 3 }]);
});

test('authorization gates the call: false → 403, true → 200', async () => {
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS })
    .use(func('greet').execute({ authorization: (req) => req.headers.has('x-allow') }))
    .use(func('whoami').execute({ authorization: () => true }));

  const denied = await app.handle(post({ name: 'greet', args: { name: 'World' } }));
  expect(denied.status).toBe(403);

  const allowed = await app.handle(
    new Request('http://localhost/rpc/greet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-allow': '1' },
      body: JSON.stringify({ name: 'World' }),
    }),
  );
  expect(allowed.status).toBe(200);
});

test('an unknown argument is a 400', async () => {
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS }).use(
    func('greet').execute({}),
  );
  const res = await app.handle(post({ name: 'greet', args: { name: 'World', nope: 1 } }));
  expect(res.status).toBe(400);
});

test('a function used without .execute() is not exposed (404)', async () => {
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS }).use(func('greet'));
  const res = await app.handle(post({ name: 'greet', args: { name: 'World' } }));
  expect(res.status).toBe(404);
});

test('a function that is not mounted is 404', async () => {
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS }).use(
    func('whoami').execute({}),
  );
  const res = await app.handle(post({ name: 'greet', args: { name: 'World' } }));
  expect(res.status).toBe(404);
});

test('a non-POST method on a function is 405', async () => {
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS }).use(
    func('whoami').execute({}),
  );
  const res = await app.handle(new Request('http://localhost/rpc/whoami'));
  expect(res.status).toBe(405);
});

test('beforeExecute and afterExecute hooks run for a function call', async () => {
  const fired: string[] = [];
  const app = new Apigen({ db: db.sql, catalog: {}, functions: FUNCTIONS }).use(
    func('whoami').execute({
      beforeExecute: ({ functionName }) => {
        fired.push(`before:${functionName}`);
      },
      afterExecute: ({ functionName, response }) => {
        fired.push(`after:${functionName}`);
        response.headers.set('x-apigen-function', functionName);
        return response;
      },
    }),
  );

  const res = await app.handle(post({ name: 'whoami' }));
  expect(res.status).toBe(200);
  expect(res.headers.get('x-apigen-function')).toBe('whoami');
  expect(fired).toEqual(['before:whoami', 'after:whoami']);
});
