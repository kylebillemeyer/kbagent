CREATE TABLE workspaces (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE workspace_integrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  role         TEXT NOT NULL,  -- 'tickets' | 'code' | 'docs'
  provider     TEXT NOT NULL,  -- 'plane' | 'linear' | 'github' | 'gitlab' | 'notion'
  external_id  TEXT NOT NULL,
  metadata     JSONB,
  UNIQUE(workspace_id, role),
  UNIQUE(provider, external_id)
);

CREATE TABLE tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  stage        TEXT NOT NULL,
  priority     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id)
);

CREATE TABLE artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          UUID NOT NULL REFERENCES tickets(id),
  artifact_type      TEXT NOT NULL,  -- 'pr' | 'doc' | 'worktree'
  provider           TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  metadata           JSONB,          -- 'pr': {repo, worktree_path, parent_pr_id?}; 'worktree': {worktree_path, pending_parent_pr?}
  review_cycle_count INT  NOT NULL DEFAULT 0,
  merged_at          TIMESTAMPTZ,
  UNIQUE(artifact_type, provider, external_id)
);

CREATE TABLE events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES artifacts(id),
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  retry_count           INT  NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  error                 TEXT
);

CREATE INDEX ON events (artifact_id, status, created_at);

CREATE TABLE active_sessions (
  artifact_id    UUID PRIMARY KEY REFERENCES artifacts(id),
  pid            INT  NOT NULL,
  workspace_name TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_minutes INT  NOT NULL
);

-- Backend-only service: the daemon connects with the service-role key (which
-- bypasses RLS). Enable RLS with no policies so the anon/authenticated roles
-- exposed via PostgREST cannot read or write these tables.
ALTER TABLE workspaces             ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_sessions        ENABLE ROW LEVEL SECURITY;
