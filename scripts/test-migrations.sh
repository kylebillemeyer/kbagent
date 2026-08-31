#!/usr/bin/env bash
#
# Applies every migration in supabase/migrations to a throwaway database, asserts
# the resulting schema, and checks that src/db/schema.ts still mirrors the SQL.
#
# Needs a Postgres server to create scratch databases on. Defaults to the
# Supabase local dev database, so `supabase start` then `npm run test:db` works
# with no further setup. CI points DATABASE_URL at its own postgres service.
#
#   DATABASE_URL=postgresql://... npm run test:db
#   SKIP_DRIZZLE_CHECK=1 npm run test:db    # migrations only
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

MIGRATED_DB="kbagent_migtest_$$"
DRIZZLE_DB="kbagent_drztest_$$"
TMPDIR_="$(mktemp -d)"

command -v psql >/dev/null || {
  echo "error: psql not found. Install the postgresql client, or run inside 'supabase start'." >&2
  exit 1
}

# Swap the database name into ADMIN_URL, preserving host, credentials and params.
db_url() { printf '%s' "$ADMIN_URL" | sed -E "s#(://[^/]+)/[^?]*#\1/$1#"; }

admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }
run_in() { local db="$1"; shift; psql "$(db_url "$db")" -v ON_ERROR_STOP=1 -X -q "$@"; }

cleanup() {
  admin -c "DROP DATABASE IF EXISTS $MIGRATED_DB" >/dev/null 2>&1 || true
  admin -c "DROP DATABASE IF EXISTS $DRIZZLE_DB"  >/dev/null 2>&1 || true
  rm -rf "$TMPDIR_"
}
trap cleanup EXIT

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

# Sorted filename order is the order `supabase db push` uses.
IFS=$'\n' migrations=($(sort <<<"${migrations[*]}")); unset IFS
for m in "${migrations[@]}"; do
  echo "    $(basename "$m")"
  run_in "$MIGRATED_DB" -f "$m" >/dev/null
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
for f in $(ls "$TMPDIR_/drizzle"/*.sql | sort); do
  run_in "$DRIZZLE_DB" -f "$f" >/dev/null
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
