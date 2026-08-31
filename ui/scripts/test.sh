#!/usr/bin/env bash
#
# Runs the API route tests against a throwaway, freshly migrated database.
#
# CREATES AND DROPS DATABASES on the server DATABASE_URL points at — see
# ../scripts/scratch-db.sh, which this shares with `npm run test:db` at the repo root.
#
#   DATABASE_URL=postgresql://... npm test        # from ui/
#
set -euo pipefail

UI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$UI/../scripts/scratch-db.sh"

check_admin_url

SCRATCH_DB="kbagent_uitest_$$"
cleanup() { admin -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> applying migrations to $SCRATCH_DB"
apply_migrations "$SCRATCH_DB"

# --conditions=react-server: src/lib/db.ts and src/lib/queries.ts import `server-only`,
# whose default export throws on purpose so a client bundle cannot pull them in. Node
# resolves it to the empty module under the same condition Next uses for a server
# component, which is the environment a route handler actually runs in.
echo "==> route tests"
DATABASE_URL="$(db_url "$SCRATCH_DB")" \
  node --conditions=react-server --import tsx --test "$UI"/test/*.test.ts
