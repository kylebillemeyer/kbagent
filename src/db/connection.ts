/**
 * Connection-string handling shared by everything that opens a Postgres client.
 *
 * Supabase hands out a pooler URI carrying `?pgbouncer=true&connection_limit=1`. Both
 * are a Prisma convention: Prisma consumes them and never sends them on. postgres.js
 * does not know them, and forwards anything it does not recognise to the server as a
 * *startup parameter* — so leaving them in place makes the server answer
 * `unrecognized configuration parameter "pgbouncer"` and no connection opens at all.
 *
 * They are therefore stripped here and translated into client options, which means
 * KB_AGENT_DATABASE_URL can hold the URI Supabase gives you, unedited.
 */

export interface ConnectionOptions {
  /** The URL with the two Prisma-convention parameters removed. */
  url: string;
  /**
   * False against a transaction-mode pooler, which hands out a different backend per
   * transaction and cannot carry a prepared statement across. Defaults to false: it
   * costs a little throughput on a direct connection but never fails, and the daemon
   * issues a handful of queries per ticket. Set `?pgbouncer=false` to opt back in.
   */
  prepare: boolean;
  /** Pool size, from `connection_limit`. */
  max: number;
}

export function poolerOptions(rawUrl: string, defaultMax = 2): ConnectionOptions {
  const url = new URL(rawUrl);

  // Absent means "assume pooled", so the safe option is the default rather than
  // something you have to know to ask for.
  const pgbouncer = (url.searchParams.get('pgbouncer') ?? 'true') === 'true';
  const limit = Number(url.searchParams.get('connection_limit') ?? defaultMax);

  url.searchParams.delete('pgbouncer');
  url.searchParams.delete('connection_limit');

  return {
    url: url.href,
    prepare: !pgbouncer,
    max: Number.isFinite(limit) && limit > 0 ? limit : defaultMax,
  };
}
