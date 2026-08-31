-- Native ticket store.
--
-- Replaces the KBAGENT-8 mirror schema, which modelled tickets as pointers into
-- an external provider (Plane) plus an event-broker spine. kbagent now owns its
-- tickets outright, so those tables are dropped rather than migrated: the
-- event-broker tables (events, active_sessions, artifacts) are discarded here and
-- a separate spec will recreate whatever shape the broker actually needs.

DROP TABLE IF EXISTS active_sessions CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS artifacts CASCADE;
DROP TABLE IF EXISTS tickets CASCADE;
DROP TABLE IF EXISTS workspace_integrations CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;

CREATE TABLE workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT NOT NULL UNIQUE,   -- 'kbagent' | 'drum-trainer' | 'garden'
  name       TEXT NOT NULL,
  repo       TEXT NOT NULL,          -- 'kylebillemeyer/drum-trainer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stages (
  id       TEXT PRIMARY KEY,  -- 'backlog'|'ready'|'in_progress'|'needs_input'|'in_review'|'done'|'cancelled'
  label    TEXT NOT NULL,
  sequence INT  NOT NULL
);

CREATE TABLE priorities (
  id       TEXT PRIMARY KEY,  -- 'urgent' | 'high' | 'medium' | 'low'
  label    TEXT NOT NULL,
  sequence INT  NOT NULL      -- urgent = 1
);

INSERT INTO stages (id, label, sequence) VALUES
  ('backlog',     'Backlog',     1),
  ('ready',       'Ready',       2),
  ('in_progress', 'In Progress', 3),
  ('needs_input', 'Needs Input', 4),
  ('in_review',   'In Review',   5),
  ('done',        'Done',        6),
  ('cancelled',   'Cancelled',   7);

INSERT INTO priorities (id, label, sequence) VALUES
  ('urgent', 'Urgent', 1),
  ('high',   'High',   2),
  ('medium', 'Medium', 3),
  ('low',    'Low',    4);

CREATE TABLE tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number            INT  NOT NULL,   -- per-workspace human id; replaces Plane's sequence_id
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',  -- markdown: ## Task / ## Acceptance criteria / ## Spec
  stage_id          TEXT NOT NULL REFERENCES stages(id) DEFAULT 'backlog',
  priority_id       TEXT NOT NULL REFERENCES priorities(id) DEFAULT 'medium',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);

CREATE INDEX ON tickets (workspace_id, stage_id);

CREATE TABLE ticket_blockers (
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  blocker_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, blocker_id),
  CHECK (ticket_id <> blocker_id)
);

CREATE TABLE ticket_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON ticket_comments (ticket_id, created_at);

-- Backend-only tables. Both the daemon and the Next.js API routes connect over
-- DATABASE_URL as ordinary Postgres clients: they do not go through PostgREST
-- and so are not subject to RLS at all. Enabling RLS with no policies denies
-- everything reachable via PostgREST's anon and authenticated roles, and nothing
-- legitimate uses that path. Authorization lives in the route handlers.
ALTER TABLE workspaces      ENABLE ROW LEVEL SECURITY;
ALTER TABLE stages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE priorities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_blockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
