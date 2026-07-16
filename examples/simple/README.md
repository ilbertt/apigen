# simple

The smallest [`@ilbertt/apigen`](../../packages/apigen/pkg/README.md) example: a single
`todos` table (no joins) showing the core patterns — a relation with one policy per verb,
`allowedColumns`, and `false` → 403. The caller is just the `x-owner-id` header.

Run `bun start:api` (deps come from `bun install` at the repo root). It connects to a Postgres
at `postgres://postgres:postgres@localhost:5432/apigen` — hard-coded in `src/index.ts` — with
`src/db/migrations/0001_init.sql` and `src/db/seed.sql` loaded. Then:

```sh
# your todos, scoped to your owner id
curl localhost:3000/todos -H 'x-owner-id: 11111111-1111-1111-1111-111111111111'

# no owner header → 403
curl -i localhost:3000/todos

# PostgREST-subset query: select + filter + order
curl 'localhost:3000/todos?select=title,done&done=is.false&order=priority.desc' \
  -H 'x-owner-id: 11111111-1111-1111-1111-111111111111'

# create a todo — WITH CHECK ties it to you
curl -X POST localhost:3000/todos -H 'x-owner-id: 11111111-1111-1111-1111-111111111111' \
  -H 'content-type: application/json' -d '{"owner":"11111111-1111-1111-1111-111111111111","title":"New"}'

# a column outside allowedColumns (id) → 403
curl -i -X POST localhost:3000/todos -H 'x-owner-id: 11111111-1111-1111-1111-111111111111' \
  -H 'content-type: application/json' -d '{"owner":"11111111-1111-1111-1111-111111111111","title":"x","id":"5"}'
```
