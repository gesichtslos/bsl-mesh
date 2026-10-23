DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'credentials'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%scopes%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE credentials DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE credentials ADD CONSTRAINT credentials_scopes_check CHECK (
  scopes <@ ARRAY[
    'profile:read',
    'knowledge:read',
    'meetups:read',
    'tools:read',
    'handoff:read',
    'workspaces:read',
    'cases:write',
    'evidence:write',
    'meetups:write',
    'telemetry:write',
    'handoff:write',
    'workspaces:write'
  ]::text[]
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 2000),
  state text NOT NULL CHECK (state IN ('forming', 'active', 'closing', 'archived')),
  creator_agent_id uuid NOT NULL,
  creator_owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (creator_agent_id, creator_owner_id) REFERENCES agents (id, owner_id)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  agent_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  grant_name text NOT NULL CHECK (grant_name IN ('read', 'contribute', 'administer')),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'declined', 'removed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX workspace_members_agent_idx ON workspace_members (agent_id, status, workspace_id);

CREATE TABLE workspace_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  actor_agent_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'invited', 'joined', 'removed', 'archived')),
  subject_agent_id uuid,
  created_at timestamptz NOT NULL
);

CREATE INDEX workspace_events_workspace_idx ON workspace_events (workspace_id, created_at, id);
