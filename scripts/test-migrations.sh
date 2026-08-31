#!/usr/bin/env bash
#
# Applies every migration in supabase/migrations to a throwaway database, asserts
# the resulting schema, and checks that src/db/schema.ts still mirrors the SQL.
#
# CREATES AND DROPS DATABASES on the server DATABASE_URL points at — see
# scripts/scratch-db.sh.
#
#   DATABASE_URL=postgresql://... npm run test:db
#   SKIP_DRIZZLE_CHECK=1 npm run test:db    # migrations only
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/scratch-db.sh"

MIGRATED_DB="kbagent_migtest_$$"
DRIZZLE_DB="kbagent_drztest_$$"

cleanup() {
  admin -c "DROP DATABASE IF EXISTS $MIGRATED_DB" >/dev/null 2>&1 || true
  admin -c "DROP DATABASE IF EXISTS $DRIZZLE_DB"  >/dev/null 2>&1 || true
  [ -n "${TMPDIR_:-}" ] && rm -rf "$TMPDIR_"
}
trap cleanup EXIT
TMPDIR_="$(mktemp -d)"

check_admin_url

# ------------------------------------------------- apply every migration ----

echo "==> applying migrations to $MIGRATED_DB"
apply_migrations "$MIGRATED_DB"

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
