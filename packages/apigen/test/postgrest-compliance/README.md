# PostgREST compliance suite

A **differential test**: every request in [`cases.ts`](./cases.ts) is fired at a real
PostgREST and at apigen in-process — both backed by the **same** Postgres — and the two
responses are asserted to match **byte-for-byte** (status, the semantic headers, and the
raw body). PostgREST is the oracle; expected values come from it, never from our reading
of the docs.

```sh
bun run test:postgrest-compliance
```

That's the whole command. The test is self-contained: `beforeAll` brings the Docker
stack ([`docker-compose.yml`](./docker-compose.yml)) up and `afterAll` tears it down. It
lives in its own folder and is **not** part of `bun test` (which stays hermetic and
Docker-free).

## How it stays honest

- **Same database, both sides.** apigen connects to the very Postgres that PostgREST
  serves, so any response difference is a difference in *our* query translation or HTTP
  envelope — not in the data.
- **Introspected catalog.** The catalog apigen runs against is produced by apigen's own
  `introspect()` against the live container (see `introspectCatalog` in
  `compliance.test.ts`), so there is no hand-written catalog to drift from the schema.
- **Owns its schema.** [`schema.sql`](./schema.sql) + [`roles.sql`](./roles.sql) +
  [`seed.sql`](./seed.sql) live here, not in the shared unit fixtures, so this suite can
  grow the exotic column types each feature needs without touching unit-test snapshots.
- **Deterministic reseed.** Both systems share one DB, so each case reseeds to a pinned
  state before *each* side — no write cross-contamination, no `now()` drift.
- **A case exists only once apigen matches.** New behavior is added by implementing it,
  then adding the case; a red case is never parked here. The table below is the ledger of
  what is and isn't covered.

## Coverage

Every row is either matched (a live differential case guarantees parity) or planned (a
tracked gap toward full PostgREST compatibility). The goal is to move every row to ✅.

| Area | Feature | Status |
| --- | --- | --- |
| Horizontal filter | `eq` `neq` `gt` `gte` `lt` `lte` `in` `is` `like` `ilike` | ✅ |
| Horizontal filter | `not.` negation, `match` `imatch`, `isdistinct` | ✅ |
| Horizontal filter | full-text `fts` `plfts` `phfts` `wfts` (with `(config)`) | ✅ |
| Horizontal filter | array/range `cs` `cd` `ov` `sl` `sr` `nxr` `nxl` `adj` | ✅ |
| Horizontal filter | `any`/`all` quantifiers | ✅ |
| Horizontal filter | logical `or` `and` `not` (nested) | ✅ |
| Vertical filter | column projection (`select=a,b`) | ✅ |
| Vertical filter | renaming `alias:col`, casting `col::type` | ✅ |
| Vertical filter | JSON paths `col->k` / `col->>k` (nested, aliased, cast) | ✅ |
| Vertical filter | aggregates `col.sum()`/`count()`/… | 🚧 |
| Ordering | `order` with `asc`/`desc`/`nullsfirst`/`nullslast` | ✅ |
| Pagination | `limit` / `offset` | ✅ |
| Pagination | `Range` / `Range-Unit` request header | ✅ |
| Counting | `Prefer: count=exact` (`Content-Range`, `206`) | ✅ |
| Counting | `count=planned` / `count=estimated` | 🚧 |
| Response | singular `application/vnd.pgrst.object+json` (`406 PGRST116`) | ✅ |
| Response | error envelope `{code,details,hint,message}` + SQLSTATE→status | ✅ |
| Writes | insert / update / delete, `Prefer: return=minimal\|representation` | ✅ |
| Writes | `Prefer: return=headers-only` + PK-derived `Location` | ✅ |
| Writes | `POST` upsert (`on_conflict`, `resolution=merge`/`ignore`; 200-on-update / 201-on-insert) | ✅ |
| Writes | `PUT` (PK-keyed upsert) + `columns=` | ✅ |
| Writes | `Prefer: missing=default` | 🚧 |
| Embedding | FK resource embedding `select=*,related(*)` — one-to-many + many-to-one | ✅ |
| Embedding | `!inner`, spread `...table`, nested embeds, embedded filters/order | 🚧 |
| Functions | `POST /rpc/<name>` | ✅ |
| Negotiation | CSV, `HEAD`, `OPTIONS`, `Accept-Profile`/`Content-Profile`, OpenAPI | 🚧 |
