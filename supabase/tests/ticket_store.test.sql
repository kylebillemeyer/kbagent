-- Asserts the schema produced by applying every migration in order.
-- Run by scripts/test-migrations.sh against a throwaway database; failures
-- raise, which aborts psql under ON_ERROR_STOP.

CREATE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void AS $fn$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERT FAILED: %', msg;
  END IF;
END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- shape ----

DO $$
DECLARE actual text;
BEGIN
  SELECT string_agg(tablename, ',' ORDER BY tablename) INTO actual
    FROM pg_tables WHERE schemaname = 'public';
  PERFORM pg_temp.assert(
    actual = 'priorities,stages,ticket_blockers,ticket_comments,tickets,workspaces',
    format('unexpected table set: %s', actual));
END $$;

-- The KBAGENT-8 tables must be gone, not merely shadowed.
DO $$
DECLARE leftovers text;
BEGIN
  SELECT string_agg(tablename, ',' ORDER BY tablename) INTO leftovers
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('artifacts', 'events', 'active_sessions', 'workspace_integrations');
  PERFORM pg_temp.assert(leftovers IS NULL,
    format('KBAGENT-8 tables survived the drop: %s', leftovers));
END $$;

-- ------------------------------------------------------------------ rls ----

DO $$
DECLARE unprotected text;
BEGIN
  SELECT string_agg(c.relname, ',' ORDER BY c.relname) INTO unprotected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  PERFORM pg_temp.assert(unprotected IS NULL,
    format('tables without RLS enabled: %s', unprotected));

  -- "RLS enabled, no policies" is the intended posture: a policy appearing here
  -- means someone started treating RLS as the authorization boundary, which it
  -- is not — the route handlers are.
  PERFORM pg_temp.assert((SELECT count(*) FROM pg_policies WHERE schemaname = 'public') = 0,
    'expected zero RLS policies');
END $$;

-- ---------------------------------------------------------------- seeds ----

DO $$
DECLARE actual text;
BEGIN
  SELECT string_agg(id || '=' || sequence, ',' ORDER BY sequence) INTO actual FROM stages;
  PERFORM pg_temp.assert(
    actual = 'backlog=1,ready=2,in_progress=3,needs_input=4,in_review=5,done=6,cancelled=7',
    format('unexpected stages seed: %s', actual));

  SELECT string_agg(id || '=' || sequence, ',' ORDER BY sequence) INTO actual FROM priorities;
  PERFORM pg_temp.assert(actual = 'urgent=1,high=2,medium=3,low=4',
    format('unexpected priorities seed: %s', actual));

  PERFORM pg_temp.assert((SELECT count(*) FROM stages WHERE label IS NULL OR label = '') = 0,
    'every stage needs a label');
  PERFORM pg_temp.assert((SELECT count(*) FROM workspaces) = 0,
    'migrations must not seed workspaces — that is cutover data');
END $$;

-- ------------------------------------------------------------- fixtures ----

INSERT INTO workspaces (slug, name, repo) VALUES ('test-ws', 'Test', 'owner/repo');
INSERT INTO tickets (workspace_id, number, title)
  SELECT id, 1, 'first' FROM workspaces WHERE slug = 'test-ws';

-- ------------------------------------------------------------- defaults ----

DO $$
DECLARE t tickets%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tickets WHERE number = 1;
  PERFORM pg_temp.assert(t.stage_id = 'backlog',  'new tickets default to backlog');
  PERFORM pg_temp.assert(t.priority_id = 'medium','new tickets default to medium priority');
  PERFORM pg_temp.assert(t.body = '',             'body defaults to empty string, not null');
  -- NOT NULL alone would make an IS NOT NULL check unfalsifiable: a missing default
  -- aborts the fixture INSERT above before this runs. Check the value instead.
  PERFORM pg_temp.assert(t.created_at > now() - interval '1 minute'
                     AND t.updated_at > now() - interval '1 minute',
    'timestamps default to now()');
END $$;

-- ---------------------------------------------------------- constraints ----

-- Each block asserts the write is REJECTED. Reaching the RAISE means the
-- constraint is missing; raise_exception is not caught by the handler below it.
DO $$
BEGIN
  BEGIN
    INSERT INTO ticket_blockers (ticket_id, blocker_id) SELECT id, id FROM tickets;
    RAISE EXCEPTION 'ASSERT FAILED: a ticket must not be able to block itself';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ticket_comments (ticket_id, author, body)
      SELECT id, 'robot', 'x' FROM tickets;
    RAISE EXCEPTION 'ASSERT FAILED: comment author must be human or agent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO tickets (workspace_id, number, title)
      SELECT workspace_id, number, 'dup' FROM tickets LIMIT 1;
    RAISE EXCEPTION 'ASSERT FAILED: ticket number must be unique per workspace';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO tickets (workspace_id, number, title, stage_id)
      SELECT id, 99, 'bad stage', 'nonexistent' FROM workspaces;
    RAISE EXCEPTION 'ASSERT FAILED: stage_id must be a foreign key into stages';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO tickets (workspace_id, number, title, priority_id)
      SELECT id, 98, 'bad priority', 'nonexistent' FROM workspaces;
    RAISE EXCEPTION 'ASSERT FAILED: priority_id must be a foreign key into priorities';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- A stage still referenced by a ticket must not be deletable, or the board
  -- vocabulary could be edited out from under live work.
  BEGIN
    DELETE FROM stages WHERE id = 'backlog';
    RAISE EXCEPTION 'ASSERT FAILED: an in-use stage must not be deletable';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- -------------------------------------------------------------- cascade ----

DO $$
BEGIN
  INSERT INTO tickets (workspace_id, number, title)
    SELECT id, 2, 'second' FROM workspaces WHERE slug = 'test-ws';
  INSERT INTO ticket_blockers (ticket_id, blocker_id)
    SELECT a.id, b.id FROM tickets a, tickets b WHERE a.number = 2 AND b.number = 1;
  INSERT INTO ticket_comments (ticket_id, author, body)
    SELECT id, 'human', 'hello' FROM tickets WHERE number = 1;

  -- Deleting a blocker ticket clears the link but leaves the blocked ticket.
  DELETE FROM tickets WHERE number = 1;
  PERFORM pg_temp.assert((SELECT count(*) FROM ticket_blockers) = 0,
    'deleting a ticket cascades to its blocker links');
  PERFORM pg_temp.assert((SELECT count(*) FROM ticket_comments) = 0,
    'deleting a ticket cascades to its comments');
  PERFORM pg_temp.assert((SELECT count(*) FROM tickets) = 1,
    'deleting a blocker must not delete the ticket it blocked');

  DELETE FROM workspaces WHERE slug = 'test-ws';
  PERFORM pg_temp.assert((SELECT count(*) FROM tickets) = 0,
    'deleting a workspace cascades to its tickets');
END $$;

SELECT 'all schema assertions passed' AS result;
