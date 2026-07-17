# @repo/apigen

Internal contributor notes for the published **`@ilbertt/apigen`** package. For
install, usage, and the public API, see **[`pkg/README.md`](./pkg/README.md)** —
that's the source of truth for anything user-facing.

## Hard invariant: the runtime is dependency-free

The request-path runtime (everything reachable from `src/index.ts` and
`src/adapters/`) must not import any third-party module. SQL is composed with a
**vendored, trimmed copy of `sql-template-tag`** (`src/builder/`, MIT — see its
`LICENSE`/`NOTICE`), never a dependency. PGlite is used **only** by the codegen
CLI (`src/codegen/`, `src/cli/`) and is an optional peer.

This is enforced at build time: `build.ts` **fails if any emitted runtime `.js`
contains a non-relative import**. Keep it that way — compose values through the
`sql` builder, never string-concatenate into query text.

## Source layout

```
src/
  index.ts        public entry: Apigen, relation, func, types (published as ".")
  api.ts          relation()/func() builders + Apigen (assembly over handle)
  contract.ts     Query, Adapter, Catalog, FunctionCatalog, ParsedRequest, Policy, auth fn types
  parse.ts        PostgREST URL → ParsedRequest
  authorize.ts    run the policy fn, resolve the column whitelist
  compile.ts      select/insert/update/delete + function calls → SQL   ← the injection surface
  handle.ts       parse → authorize → compile → adapter → Response
  http.ts         ApiError + status codes + JSON responses
  builder/        vendored sql-template-tag + ident() + using/withCheck tags
  adapters/       createAdapter + postgres.js/Bun.SQL adapter   (published as "./adapters")
  codegen/        introspect ephemeral PGlite → emit api.gen.ts
  cli/            `apigen gen` — a parsh CLI (commands/ + generated command-tree.gen.ts)
```

## Build

`bun run build` (`build.ts`) produces the publishable `pkg/`:

- **Runtime** — `tsc` (`build:lib`) emits per-file `.js` + `.d.ts` for `src/`
  (excluding `codegen/` + `cli/`). `rewriteRelativeImportExtensions` turns the
  `.ts` import specifiers into `.js` in the `.js`; a tiny pass in `build.ts` does
  the same for the `.d.ts` (tsgo doesn't rewrite those). Zero external deps —
  asserted.
- **CLI** — `Bun.build` bundles `cli/main.ts` → `cli/main.js`, inlining
  `@parshjs/core` + `zod`; `@electric-sql/pglite` stays external (the optional
  peer, lazy-imported).

The `codegen` script (`parsh-codegen generate`) regenerates
`cli/command-tree.gen.ts` from the files under `cli/commands/`; `build.ts` runs it
first so the bundle can't embed a stale tree.

## Conventions

- **Relative imports with the `.ts` extension** (e.g. `import { sql } from './builder/index.ts'`)
  — the pinned TypeScript compiler requires the extension, and relative (not `#*`)
  specifiers are what emit cleanly into declarations.

## Dev scripts

- `bun run check:types` — `tsc` (no emit)
- `bun run codegen` — regenerate the parsh command tree
- `bun test` — full suite against pglite-socket + a postgres.js devDependency.
  Fixtures (migrations + seed) live under `test/fixtures/`; the socket helper is
  `test/helpers/db.ts`. The committed `test/__generated__/*.gen.ts` files
  (`todos.gen.ts`, `functions.gen.ts`) are codegen fixtures kept in the tsconfig
  include so `check:types` also typechecks emitted output; the codegen tests
  regenerate them.
