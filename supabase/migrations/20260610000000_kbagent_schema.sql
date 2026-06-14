CREATE SCHEMA IF NOT EXISTS kbagent;

CREATE TABLE kbagent.workspaces (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE kbagent.workspace_integrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES kbagent.workspaces(id),
  role         TEXT NOT NULL,  -- 'tickets' | 'code' | 'docs'
  provider     TEXT NOT NULL,  -- 'plane' | 'linear' | 'github' | 'gitlab' | 'notion'
  external_id  TEXT NOT NULL,
  metadata     JSONB,
  UNIQUE(workspace_id, role),
  UNIQUE(provider, external_id)
);

CREATE TABLE kbagent.tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES kbagent.workspaces(id),
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  stage        TEXT NOT NULL,
  priority     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id)
);

CREATE TABLE kbagent.artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          UUID NOT NULL REFERENCES kbagent.tickets(id),
  artifact_type      TEXT NOT NULL,  -- 'pr' | 'doc' | 'worktree'
  provider           TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  metadata           JSONB,          -- 'pr': {repo, worktree_path, parent_pr_id?}; 'worktree': {worktree_path, pending_parent_pr?}
  review_cycle_count INT  NOT NULL DEFAULT 0,
  merged_at          TIMESTAMPTZ,
  UNIQUE(artifact_type, provider, external_id)
);

CREATE TABLE kbagent.events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES kbagent.artifacts(id),
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  retry_count           INT  NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  error                 TEXT
);

CREATE INDEX ON kbagent.events (artifact_id, status, created_at);

CREATE TABLE kbagent.active_sessions (
  artifact_id    UUID PRIMARY KEY REFERENCES kbagent.artifacts(id),
  pid            INT  NOT NULL,
  workspace_name TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_minutes INT  NOT NULL
);
