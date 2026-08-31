#!/usr/bin/env bash
#
# Shared helpers for the test scripts that need a throwaway database. Sourced, not
# executed — see scripts/test-migrations.sh and scripts/test-provider.sh.
#
# CREATES AND DROPS DATABASES on the server DATABASE_URL points at. Callers only ever
# touch their own `kbagent_*test_<pid>` scratch databases — never the one named in the
# URL — but point this at a local or CI server, not at anything you care about.
#
# Defaults to the Supabase local dev database, so `supabase start` then a test script
# works with no further setup.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Swap the database name into ADMIN_URL, preserving host, port, credentials and params.
#
# Parsed with Node's URL rather than sed: a regex that assumes a `/dbname` path
# silently returns the URL unchanged for `postgresql://host:5432` or
# `postgresql://host?sslmode=require`, and the scratch database name is then dropped
# on the floor — every statement lands in whatever database libpq resolves instead.
db_url() {
  node -e '
    const u = new URL(process.argv[1]);
    u.pathname = "/" + process.argv[2];
    process.stdout.write(u.href);
  ' "$ADMIN_URL" "$1"
}

admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }
run_in() { local db="$1"; shift; psql "$(db_url "$db")" -v ON_ERROR_STOP=1 -X -q "$@"; }

# Verify psql exists and ADMIN_URL names a reachable database, or exit non-zero.
check_admin_url() {
  command -v psql >/dev/null || {
    echo "error: psql not found. Install the postgresql client, or run inside 'supabase start'." >&2
    exit 1
  }

  # Fail loudly rather than fall back to a libpq default: without a database name in the
  # URL there is nothing to connect to for the CREATE DATABASE statements below.
  node -e '
    let u;
    try { u = new URL(process.argv[1]); } catch { console.error("not a valid URL"); process.exit(1); }
    if (!u.pathname || u.pathname === "/") { console.error("no database name"); process.exit(1); }
  ' "$ADMIN_URL" 2>/dev/null || {
    echo "error: DATABASE_URL must be a full URL including a database name," >&2
    echo "       e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres" >&2
    exit 1
  }

  if ! admin -c 'SELECT 1' >/dev/null 2>&1; then
    echo "error: cannot connect to $ADMIN_URL" >&2
    echo "       start a local database ('supabase start') or set DATABASE_URL." >&2
    exit 1
  fi
}

# Create the named scratch database and apply every migration to it, in order.
apply_migrations() {
  local db="$1"
  admin -c "CREATE DATABASE $db" >/dev/null

  shopt -s nullglob
  local migrations=("$ROOT"/supabase/migrations/*.sql)
  shopt -u nullglob
  [ ${#migrations[@]} -gt 0 ] || { echo "error: no migrations found" >&2; exit 1; }

  # Pathname expansion already yields sorted results, which is the order
  # `supabase db push` applies them in.
  local m
  for m in "${migrations[@]}"; do
    echo "    $(basename "$m")"
    # -1 wraps each file in a transaction. These migrations drop tables before
    # recreating them, so a failure partway through a bare `psql -f` would leave the
    # database with the old tables gone and the new ones half-built.
    run_in "$db" -1 -f "$m" >/dev/null
  done
}
