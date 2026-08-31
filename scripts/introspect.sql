-- Emits a normalized, sorted description of the public schema: one line per
-- column, constraint and index. Used to compare two databases for structural
-- equality (see test-migrations.sh).
--
-- Constraint and index NAMES are deliberately excluded. Drizzle names foreign
-- keys `<table>_<col>_<reftable>_<refcol>_fk` while Postgres names the ones in
-- the migration `<table>_<col>_fkey`; that difference is cosmetic and would
-- otherwise swamp the diff. Definitions are compared, names are not.
SELECT line FROM (
  SELECT 'COLUMN    |' || table_name || '|' || column_name || '|' || data_type
         || '|null=' || is_nullable
         || '|default=' || coalesce(column_default, '-') AS line
    FROM information_schema.columns
   WHERE table_schema = 'public'

  UNION ALL

  SELECT 'CONSTRAINT|' || rel.relname || '|' || con.contype::text || '|'
         || pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'

  UNION ALL

  SELECT 'INDEX     |' || tablename || '|'
         || regexp_replace(indexdef, ' INDEX [A-Za-z0-9_]+ ON ', ' INDEX ON ')
    FROM pg_indexes
   WHERE schemaname = 'public'
) s
ORDER BY 1;
