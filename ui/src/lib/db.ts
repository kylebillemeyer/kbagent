// Poisons this module for any client bundle: if a component ever imports it, directly
// or transitively, `next build` fails instead of shipping the database to the browser.
import 'server-only';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// The Drizzle mirror of supabase/migrations/*.sql, shared with the daemon and reached
// by relative path out of ui/ — see experimental.externalDir in next.config.ts.
// Drizzle is confined to this module and ./queries.ts; every route handler works in
// the Zod shapes from ./contracts. See src/lib/contracts/index.ts.
import * as schema from '../../../src/db/schema';

/**
 * Drizzle over `DATABASE_URL`. Supabase is used for auth only — never `supabase.from()`,
 * which would go through PostgREST, where the tables have RLS on and no policies.
 */
export type Db = ReturnType<typeof createDb>['db'];

/**
 * Normalize the connection string to the pooled shape and split out the two pooler
 * parameters, which are directives to the *client*, not to Postgres.
 *
 * `?pgbouncer=true&connection_limit=1` is the canonical Supabase transaction-pooler
 * URI. Both parameters are a Prisma convention: Prisma consumes them and never sends
 * them on. postgres.js does not know them, and anything it does not recognise it
 * forwards as a startup parameter — so leaving them in the URL makes the server
 * answer `unrecognized configuration parameter "pgbouncer"` and no connection opens
 * at all. They are therefore appended (so the value in the environment is the URI
 * Supabase hands you, unedited) and then translated here:
 *
 *   pgbouncer=true      -> prepare: false. The transaction-mode pooler hands out a
 *                          different backend per transaction and cannot carry a
 *                          prepared statement across. The daemon's provider makes the
 *                          same choice for the same reason.
 *   connection_limit=N  -> max: N. One connection per serverless instance; the pooler
 *                          multiplexes, so a per-instance pool would only hold
 *                          backends open against it.
 */
export function poolerOptions(rawUrl: string): { url: string; prepare: boolean; max: number } {
  const url = new URL(rawUrl);
  if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true');
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1');

  const pgbouncer = url.searchParams.get('pgbouncer') === 'true';
  const limit = Number(url.searchParams.get('connection_limit'));

  url.searchParams.delete('pgbouncer');
  url.searchParams.delete('connection_limit');

  return {
    url: url.href,
    prepare: !pgbouncer,
    max: Number.isFinite(limit) && limit > 0 ? limit : 1,
  };
}

function createDb(rawUrl: string) {
  const { url, prepare, max } = poolerOptions(rawUrl);
  const client = postgres(url, { prepare, max });
  return { client, db: drizzle(client, { schema }) };
}

// Cached on globalThis so Next's dev-server module reloading does not leak a pool per
// edit, and so a warm serverless instance reuses its connection.
const globalForDb = globalThis as unknown as {
  kbagentDb?: { url: string } & ReturnType<typeof createDb>;
};

/** The shared client. Resolved lazily: DATABASE_URL is read on first query, not on import. */
export function db(): Db {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL is not set');

  // Keyed by URL so a test pointed at a fresh scratch database gets a fresh pool
  // rather than silently reusing one aimed somewhere else.
  const cached = globalForDb.kbagentDb;
  if (cached && cached.url !== rawUrl) {
    void cached.client.end().catch(() => {});
    globalForDb.kbagentDb = undefined;
  }
  if (!globalForDb.kbagentDb) {
    globalForDb.kbagentDb = { url: rawUrl, ...createDb(rawUrl) };
  }
  return globalForDb.kbagentDb.db;
}

/**
 * Release the pool. Nothing in the deployed app calls this — a serverless instance is
 * torn down with its sockets — but a test process cannot exit while a connection is
 * still open, so it needs a way to let go.
 */
export async function closeDb(): Promise<void> {
  const current = globalForDb.kbagentDb;
  globalForDb.kbagentDb = undefined;
  if (current) await current.client.end();
}
