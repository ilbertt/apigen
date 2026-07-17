# pg-largeobjects

Serve videos stored as **Postgres large objects** over HTTP — with browser range
requests, so you can point a `<video>` straight at the URL and it seeks like any CDN.

The bytes live in `pg_largeobject`; the `videos` table keeps only metadata plus each
video's large-object id (`loid`). The point is the split of work:

- **apigen** owns the endpoint — it routes `GET /videos`, applies the relation's
  authorization, and runs the select.
- A **Postgres function**, `video_chunk(id, range_start, range_length)`, does the data
  work: it clamps the requested window to the file's bounds and reads that slice out of
  the large object with `lo_get`.
- The **`afterExecute`** hook does only what SQL can't: read the request's `Range`
  header and return `206 Partial Content` (or `200`) with the right `Content-Type` /
  `Accept-Ranges` / `Content-Range`.

Because the streaming keys off the `Range` **header** (not query args), the URL is a
plain `GET` a browser can use directly:

```html
<video src="http://localhost:3000/videos?id=eq.2" controls></video>
```

- `GET /videos` — JSON catalog.
- `GET /videos?id=eq.<n>` — the video, honouring `Range` for `206`. It streams based on
  the *authorized row count*, not its columns, so a caller's `?select=` can't break it.

Run `bun start:api`, then:

```sh
# catalog
curl localhost:3000/videos

# play it: open this URL in a browser, or in a <video src="…"> tag
#   http://localhost:3000/videos?id=eq.1

# a range request, like a video player seeking → 206 Partial Content
curl -i 'localhost:3000/videos?id=eq.2' -H 'range: bytes=0-1023'
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql`
loaded. The seed stores two real (tiny) mp4s as large objects via `lo_from_bytea`.*
