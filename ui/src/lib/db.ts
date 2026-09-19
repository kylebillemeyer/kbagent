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
import { poolerOptions as sharedPoolerOptions, type ConnectionOptions } from '../../../src/db/connection';

/**
 * Drizzle over `DATABASE_URL`. Supabase is used for auth only — never `supabase.from()`,
 * which would go through PostgREST, where the tables have RLS on and no policies.
 */
export type Db = ReturnType<typeof createDb>['db'];

/**
 * The connection-string handling is shared with the daemon — see
 * ../../../src/db/connection.ts for why `?pgbouncer=true&connection_limit=1` cannot be
 * handed to postgres.js as-is. Only the default pool size differs: one connection per
 * serverless instance, since the pooler multiplexes and a per-instance pool would just
 * hold backends open against it.
 */
export const poolerOptions = (rawUrl: string): ConnectionOptions => sharedPoolerOptions(rawUrl, 1);

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
