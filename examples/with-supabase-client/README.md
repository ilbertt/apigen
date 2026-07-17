# with-supabase-client

apigen is PostgREST-compatible, so the official [`@supabase/supabase-js`](https://github.com/supabase/supabase-js)
client talks to an apigen backend with no shim — no webapp, just a `src/client.ts`.

Two pieces:

- **`src/index.ts`** — the apigen server. supabase-js sends every request to
  `${url}/rest/v1/<table>`, so the server strips that `/rest/v1` mount prefix before
  handing the request to `api.handle` (which routes from the root).
- **`src/client.ts`** — a plain supabase-js client. The Supabase "anon key" is just
  the bearer token `auth()` resolves: supabase-js sends it as
  `Authorization: Bearer <key>`, exactly what apigen reads. Here the key is `tok_ada`,
  the seeded customer.

```ts
const supabase = createClient('http://localhost:3000', 'tok_ada');

// scoped to Ada by the relation's select policy
const { data } = await supabase.from('orders').select('*');

// PostgREST query operators map straight through
await supabase.from('products').select('name,price').order('price', { ascending: false });
```

Run the server, then the client:

```sh
bun start:api      # terminal 1
bun start:client   # terminal 2
```

*Needs a Postgres at `localhost:5432/apigen` with `src/db/migrations` + `src/db/seed.sql` loaded.*
