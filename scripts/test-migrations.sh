#!/usr/bin/env bash
#
# Applies every migration in supabase/migrations to a throwaway database, asserts
# the resulting schema, and checks that src/db/schema.ts still mirrors the SQL.
#
# CREATES AND DROPS DATABASES on the server DATABASE_URL points at. It only ever
# touches its own `kbagent_*test_<pid>` scratch databases — never the one named in
# the URL — but point it at a local or CI server, not at anything you care about.
#
# Defaults to the Supabase local dev database, so `supabase start` then
# `npm run test:db` works with no further setup.
#
#   DATABASE_URL=postgresql://... npm run test:db
#   SKIP_DRIZZLE_CHECK=1 npm run test:db    # migrations only
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

command -v psql >/dev/null || {
  echo "error: psql not found. Install the postgresql client, or run inside 'supabase start'." >&2
  exit 1
}

MIGRATED_DB="kbagent_migtest_$$"
DRIZZLE_DB="kbagent_drztest_$$"

cleanup() {
  admin -c "DROP DATABASE IF EXISTS $MIGRATED_DB" >/dev/null 2>&1 || true
  admin -c "DROP DATABASE IF EXISTS $DRIZZLE_DB"  >/dev/null 2>&1 || true
  [ -n "${TMPDIR_:-}" ] && rm -rf "$TMPDIR_"
}
trap cleanup EXIT
TMPDIR_="$(mktemp -d)"

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

# ------------------------------------------------- apply every migration ----

echo "==> applying migrations to $MIGRATED_DB"
admin -c "CREATE DATABASE $MIGRATED_DB" >/dev/null

shopt -s nullglob
migrations=("$ROOT"/supabase/migrations/*.sql)
shopt -u nullglob
[ ${#migrations[@]} -gt 0 ] || { echo "error: no migrations found" >&2; exit 1; }

# Pathname expansion already yields sorted results, which is the order
# `supabase db push` applies them in.
for m in "${migrations[@]}"; do
  echo "    $(basename "$m")"
  # -1 wraps each file in a transaction. These migrations drop tables before
  # recreating them, so a failure partway through a bare `psql -f` would leave the
  # database with the old tables gone and the new ones half-built.
  run_in "$MIGRATED_DB" -1 -f "$m" >/dev/null
done

# ------------------------------------------------------- assert the shape ---

shopt -s nullglob
tests=("$ROOT"/supabase/tests/*.test.sql)
shopt -u nullglob
for t in "${tests[@]}"; do
  echo "==> $(basename "$t")"
  run_in "$MIGRATED_DB" -f "$t"
done

# --------------------------------------- schema.ts still mirrors the SQL ----

if [ -n "${SKIP_DRIZZLE_CHECK:-}" ]; then
  echo "==> skipping Drizzle mirror check (SKIP_DRIZZLE_CHECK set)"
  exit 0
fi

echo "==> checking src/db/schema.ts mirrors the migrations"
# Drizzle never applies schema in this project, so its definitions can silently
# drift from the SQL. Generate DDL from schema.ts, apply it to a second scratch
# database, and compare the two structurally.
"$ROOT/node_modules/.bin/drizzle-kit" generate \
  --dialect postgresql \
  --schema "$ROOT/src/db/schema.ts" \
  --out "$TMPDIR_/drizzle" >/dev/null

admin -c "CREATE DATABASE $DRIZZLE_DB" >/dev/null
for f in "$TMPDIR_/drizzle"/*.sql; do
  run_in "$DRIZZLE_DB" -1 -f "$f" >/dev/null
done

run_in "$MIGRATED_DB" -At -f "$ROOT/scripts/introspect.sql" > "$TMPDIR_/from-sql.txt"
run_in "$DRIZZLE_DB"  -At -f "$ROOT/scripts/introspect.sql" > "$TMPDIR_/from-drizzle.txt"

if ! diff -u "$TMPDIR_/from-sql.txt" "$TMPDIR_/from-drizzle.txt" \
     --label "from supabase/migrations" --label "from src/db/schema.ts"; then
  echo >&2
  echo "error: src/db/schema.ts has drifted from supabase/migrations." >&2
  echo "       The SQL is authoritative — hand-edit schema.ts to match it." >&2
  exit 1
fi
echo "    schema.ts matches"

echo
echo "all migration tests passed"
