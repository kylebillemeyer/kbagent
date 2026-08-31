#!/usr/bin/env bash
#
# Runs the provider integration tests against a real, freshly migrated database.
#
# src/provider/native.ts is almost entirely SQL: ordering, a correlated NOT EXISTS,
# a transactional stage-change-plus-comment. Mocking the driver would only assert that
# the query builder was called, so these tests talk to Postgres.
#
# CREATES AND DROPS A DATABASE on the server DATABASE_URL points at — see
# scripts/scratch-db.sh.
#
#   DATABASE_URL=postgresql://... npm run test:provider
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/scratch-db.sh"

PROVIDER_DB="kbagent_provtest_$$"

cleanup() {
  admin -c "DROP DATABASE IF EXISTS $PROVIDER_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

check_admin_url

echo "==> applying migrations to $PROVIDER_DB"
apply_migrations "$PROVIDER_DB"

echo "==> provider integration tests"
# tsx/cjs lets node's built-in test runner load the TypeScript sources directly; the
# project is CommonJS, so no loader flag or extra dependency is needed.
KB_AGENT_DATABASE_URL="$(db_url "$PROVIDER_DB")" \
  node --require tsx/cjs --test "$ROOT"/test/integration/*.test.ts
