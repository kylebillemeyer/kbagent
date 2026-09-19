# kbagent UI

The human half of the loop: a mobile-first board over the kbagent ticket store. This PR
is the **server side only** — scaffolding, auth, and the REST API with its Zod
contracts. The pages come in a separate PR.

## Why it is a separate manifest

`ui/` has its own `package.json` and is what Vercel deploys (project root directory:
`ui/`). The root manifest is installed globally as the `kbagent` binary and must never
grow a Next dependency tree, so nothing at the root references this directory.

The one thing the two share is `../src/db/schema.ts`, the Drizzle mirror of
`supabase/migrations/*.sql`, imported by relative path. That needs
`experimental.externalDir: true` in `next.config.ts`, and was chosen over restructuring
the repo into npm workspaces: one shared file does not justify a `packages/*` rewrite.
On Vercel this also needs *Include files outside the root directory* left enabled (it
is the default), or `../src/db/schema.ts` will not be in the build context.

## The contract boundary

`src/lib/contracts/` holds Zod schemas for every request and response. The client
derives its types with `z.infer` and never sees a Drizzle row type — a database column
is not an API field, and a component importing a table type would turn every migration
into a breaking UI change. Two things enforce it: `src/lib/db.ts` and
`src/lib/queries.ts` import `server-only`, so a client component that reaches them
fails the build; and `test/contracts.test.ts` fails if any other file imports the
schema, `drizzle-orm` or `postgres`. There is no OpenAPI document and no codegen — the
only consumer is the React app in this same build.

`src/lib/queries.ts` is the seam: Drizzle in, contract shapes out. Route handlers do
four things — authorize, parse, call a query, respond.

## Authorization

Supabase Auth (magic link) restricted to the single address in `ALLOWED_EMAIL`. Every
route begins with `requireAllowedUser()`: 401 with no session, 403 for a signed-in
address that is not the allowed one. That allowlist is the entire model — a second user
is a redesign, not another entry.

RLS is **not** the boundary. Drizzle connects over `DATABASE_URL` as an ordinary
Postgres client, bypasses PostgREST, and is not subject to RLS at all. The route
handlers are the only thing between a request and the data, which is why the auth check
is the first statement in each of them and is tested on every route. Supabase is used
for auth only; `supabase.from()` appears nowhere.

## Environment

See `.env.example`. `DATABASE_URL` is the Supabase pooler URI; `src/lib/db.ts` appends
`?pgbouncer=true&connection_limit=1` when absent and then *consumes* both parameters —
they are a Prisma convention, and postgres.js forwards anything it does not recognise
to the server as a startup parameter, which fails the connection outright. They become
`prepare: false` (the transaction pooler cannot carry prepared statements — the daemon
makes the same choice) and `max: 1`.

## Development

```bash
npm run dev        # next dev
npm run typecheck  # tsc --noEmit
npm run build      # next build
npm test           # route handlers against a throwaway, freshly migrated database
```

`npm test` runs `scripts/test.sh`, which uses the repo's shared `scripts/scratch-db.sh`
to create a scratch database, apply every migration to it, and drop it afterwards. It
defaults to the Supabase local dev database; override with `DATABASE_URL`. The routes
are exercised as plain functions — `POST(request, ctx)` — against real Postgres, with
only the Supabase session read stubbed (`session.read` in `src/lib/auth.ts`).
