/**
 * Hermetic coverage for the OpenAPI document apigen serves at `GET /openapi`. The
 * document is built from the catalog + mounted operations and does not touch the
 * database. apigen serves it under its OWN identity (version, title) at `/openapi` —
 * deliberately not byte-for-byte with PostgREST's `/`, which embeds PostgREST's own
 * version string; see openapi.ts.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Catalog } from '../../src/contract.js';
import { Apigen, relation } from '../../src/index.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const MIGRATIONS = `
  create table authors (id bigint generated always as identity primary key, name text not null);
  create table books (
    id bigint generated always as identity primary key,
    author_id bigint not null references authors (id),
    title text not null,
    price numeric not null default 0,
    available boolean not null default true
  );
  create table openapi (id integer primary key, label text not null);
  create schema extra;
  create table extra.tags (id integer primary key, label text not null);
`;

const CATALOG: Catalog = {
  authors: { id: 'int8', name: 'text' },
  books: { id: 'int8', author_id: 'int8', title: 'text', price: 'numeric', available: 'bool' },
};
const EXTRA: Catalog = { tags: { id: 'int4', label: 'text' } };

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb({ migrations: MIGRATIONS });
});

afterEach(async () => {
  await db.end();
});

/** authors is read-only; books is full CRUD; tags lives in the `extra` schema. */
function buildApp(): Apigen {
  return new Apigen({
    db: db.sql,
    catalog: CATALOG,
    primaryKeys: { authors: ['id'], books: ['id'] },
    foreignKeys: {
      books: [{ columns: ['author_id'], foreignRelation: 'authors', foreignColumns: ['id'] }],
    },
    schemas: { extra: { catalog: EXTRA, primaryKeys: { tags: ['id'] } } },
    // Opt into `/openapi` (an empty config is enough).
    openapi: {},
  })
    .use(relation('authors').select({}))
    .use(relation('books').select({}).insert({}).update({}).delete({}))
    .use(relation('tags', { schema: 'extra' }).select({}));
}

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary JSON out of the served document.
async function fetchDoc(req: Request): Promise<{ res: Response; doc: any }> {
  const res = await buildApp().handle(req);
  const text = await res.text();
  return { res, doc: text === '' ? undefined : JSON.parse(text) };
}

test('GET /openapi serves a Swagger 2.0 document under apigen identity', async () => {
  const { res, doc } = await fetchDoc(new Request('http://api.example.com/openapi'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/openapi+json; charset=utf-8');
  expect(doc.swagger).toBe('2.0');
  // version is omitted unless the caller configures one (apigen can't know it at runtime).
  expect(doc.info.version).toBeUndefined();
  expect(doc.info.title).toBe('apigen (public schema)');
  expect(doc.host).toBe('api.example.com');
  expect(doc.schemes).toEqual(['http']);
});

test('info.title/version come from the openapi option when set', async () => {
  const configured = new Apigen({
    db: db.sql,
    catalog: CATALOG,
    openapi: { title: 'My API', version: '1.4.0' },
  }).use(relation('authors').select({}));
  const res = await configured.handle(new Request('http://x/openapi'));
  const doc = (await res.json()) as { info: { title: string; version?: string } };
  expect(doc.info.title).toBe('My API');
  expect(doc.info.version).toBe('1.4.0');
});

test('paths list one entry per mounted operation', async () => {
  const { doc } = await fetchDoc(new Request('http://x/openapi'));
  // authors is read-only.
  expect(Object.keys(doc.paths['/authors'])).toEqual(['get']);
  // books exposes every verb.
  expect(Object.keys(doc.paths['/books']).sort()).toEqual(['delete', 'get', 'patch', 'post']);
  // tags is in another schema and is absent from the public document.
  expect(doc.paths['/tags']).toBeUndefined();
});

test('definitions carry column types and PK/FK notes', async () => {
  const { doc } = await fetchDoc(new Request('http://x/openapi'));
  expect(doc.definitions.books.properties.price).toEqual({ type: 'number', format: 'numeric' });
  expect(doc.definitions.books.properties.available).toEqual({ type: 'boolean', format: 'bool' });
  expect(doc.definitions.books.properties.id.description).toContain('This is a Primary Key.');
  expect(doc.definitions.books.properties.author_id.description).toContain(
    'Foreign Key to `authors.id`',
  );
});

test('HEAD /openapi returns the headers with no body', async () => {
  const res = await buildApp().handle(new Request('http://x/openapi', { method: 'HEAD' }));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/openapi+json; charset=utf-8');
  expect(await res.text()).toBe('');
});

test('Accept-Profile selects which schema the document describes', async () => {
  const { res, doc } = await fetchDoc(
    new Request('http://x/openapi', { headers: { 'accept-profile': 'extra' } }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-profile')).toBe('extra');
  expect(doc.info.title).toBe('apigen (extra schema)');
  expect(Object.keys(doc.paths)).toEqual(['/tags']);
});

test('/openapi is not exposed unless the openapi option is set', async () => {
  const app = new Apigen({ db: db.sql, catalog: CATALOG }).use(relation('authors').select({}));
  const res = await app.handle(new Request('http://x/openapi'));
  // No `openapi` option → `/openapi` is treated as a (missing) relation, not the document.
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).not.toBe('application/openapi+json; charset=utf-8');
});

test('a relation literally named "openapi" shadows the document even when opted in', async () => {
  const app = new Apigen({
    db: db.sql,
    catalog: { openapi: { id: 'int4', label: 'text' } },
    openapi: {},
  }).use(relation('openapi').select({}));
  const res = await app.handle(new Request('http://x/openapi?limit=0'));
  // Served as a normal relation read (JSON array), not the OpenAPI document.
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(await res.json()).toEqual([]);
});
