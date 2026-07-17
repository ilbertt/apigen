# simple

The smallest apigen example: one `todos` table, no joins. The caller is the
`x-owner-id` header.

Run `bun start:api`, then:

```sh
# your todos
curl localhost:3000/todos -H 'x-owner-id: 11111111-1111-1111-1111-111111111111'

# filter + select + order
curl 'localhost:3000/todos?select=title,done&done=is.false&order=priority.desc' \
  -H 'x-owner-id: 11111111-1111-1111-1111-111111111111'

# create one
curl -X POST localhost:3000/todos -H 'x-owner-id: 11111111-1111-1111-1111-111111111111' \
  -H 'content-type: application/json' \
  -d '{"owner":"11111111-1111-1111-1111-111111111111","title":"New"}'

# no owner header
curl -i localhost:3000/todos   # 403
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql` loaded.*
