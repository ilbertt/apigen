/** biome-ignore-all lint/complexity/useMaxParams: apigen authorization fns are (req, { sql }) by design. */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { generateFromDb, generateFromSql } from '../src/codegen/generate.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const MIGRATIONS = `
  create table todos (
    id bigint generated always as identity primary key,
    owner uuid not null,
    title text not null,
    done boolean not null default false,
    priority integer not null default 0,
    notes text
  );
`;

const GENERATED_PATH = join(import.meta.dir, '__generated__', 'todos.gen.ts');

let source: string;

beforeAll(async () => {
  source = await generateFromSql({ migrations: MIGRATIONS, moduleSpecifier: '@repo/apigen' });
  await Bun.write(GENERATED_PATH, source);
});

test('catalog maps columns to pgTypes (int8/numeric as-is)', () => {
  expect(source).toContain('todos: {');
  expect(source).toContain("id: 'int8',");
  expect(source).toContain("owner: 'uuid',");
  expect(source).toContain("done: 'bool',");
  expect(source).toContain("priority: 'int4',");
  expect(source).toContain("notes: 'text',");
});

test('row type surfaces int8 as string, integer as number, nullable as | null', () => {
  expect(source).toContain('export interface Todos {');
  expect(source).toContain('id: string;');
  expect(source).toContain('priority: number;');
  expect(source).toContain('done: boolean;');
  expect(source).toContain('notes: string | null;');
});

test('emits catalog-bound relation factory and Apigen class', () => {
  expect(source).toContain('export function relation<R extends keyof Catalog & string>');
  expect(source).toContain('export class Apigen extends ApigenBase');
});

test('the generated module works end-to-end against a live db', async () => {
  const gen = (await import(GENERATED_PATH)) as typeof import('./__generated__/todos.gen.ts');
  const db: TestDb = await createTestDb({
    migrations: `${MIGRATIONS}
      insert into todos (owner, title, priority) values
        ('11111111-1111-1111-1111-111111111111', 'ship it', 2);
    `,
  });
  try {
    const todos = gen.relation('todos').select({
      authorization: (_req, { sql }) => ({
        policy: sql.using`true`,
        allowedColumns: ['id', 'title', 'priority', 'done'],
      }),
    });
    const app = new gen.Apigen({ db: db.sql }).use(todos);

    const res = await app.handle(new Request('http://localhost/todos'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'ship it', priority: 2, done: false });
    expect(typeof rows[0]?.id).toBe('string');
  } finally {
    await db.end();
  }
});

test('generateFromDb introspects a live connection, matching the migrations path', async () => {
  const db = await createTestDb({ migrations: MIGRATIONS });
  try {
    const fromDb = await generateFromDb({ db: db.sql, moduleSpecifier: '@repo/apigen' });
    expect(fromDb).toBe(source);
  } finally {
    await db.end();
  }
});

afterAll(() => {
  // Keep test/__generated__/todos.gen.ts around so `tsc` typechecks the emitted output.
});
