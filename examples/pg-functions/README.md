# pg-functions

apigen exposing Postgres **functions** as `POST /rpc/<name>` endpoints. A function's
authorization is a coarse gate — *may this caller run it at all* — unlike relations,
whose policies scope individual rows. Arguments are sent as a JSON body and bound by
name, so omitted arguments fall back to the function's defaults.

Run `bun start:api`, then:

```sh
# public, pure function (the optional `excited` arg omitted → its default)
curl -X POST localhost:3000/rpc/greet \
  -H 'content-type: application/json' -d '{"name":"World"}'

# ...and with the optional arg
curl -X POST localhost:3000/rpc/greet \
  -H 'content-type: application/json' -d '{"name":"World","excited":true}'

# set-returning function → one JSON object per row
curl -X POST localhost:3000/rpc/search_articles \
  -H 'content-type: application/json' -d '{"query":"apigen"}'

# no arguments → empty body
curl -X POST localhost:3000/rpc/server_time

# admin-only: without the token → 403
curl -i -X POST localhost:3000/rpc/publish_article \
  -H 'content-type: application/json' -d '{"article_slug":"draft-notes"}'

# with the admin token → publishes and returns the row
curl -X POST localhost:3000/rpc/publish_article \
  -H 'authorization: Bearer admin-token' \
  -H 'content-type: application/json' -d '{"article_slug":"draft-notes"}'
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql` loaded.*
