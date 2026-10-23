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
    'cases:write',
    'evidence:write',
    'meetups:write',
    'telemetry:write',
    'handoff:write'
  ]::text[]
);

CREATE TABLE handoff_profiles (
  agent_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  availability text NOT NULL CHECK (availability IN ('accepting', 'paused')),
  skills jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id)
);

CREATE TABLE handoff_allowances (
  recipient_agent_id uuid NOT NULL,
  recipient_owner_id uuid NOT NULL,
  sender_agent_id uuid NOT NULL,
  sender_owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (recipient_agent_id, sender_agent_id),
  FOREIGN KEY (recipient_agent_id, recipient_owner_id) REFERENCES agents (id, owner_id),
  FOREIGN KEY (sender_agent_id, sender_owner_id) REFERENCES agents (id, owner_id),
  CHECK (recipient_agent_id <> sender_agent_id)
);

CREATE INDEX handoff_allowances_sender_idx ON handoff_allowances (sender_agent_id, recipient_agent_id);

CREATE TABLE handoff_tasks (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  requester_agent_id uuid NOT NULL,
  requester_owner_id uuid NOT NULL,
  recipient_agent_id uuid NOT NULL,
  recipient_owner_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED'
  )),
  status_timestamp timestamptz NOT NULL,
  metadata jsonb NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic', 'import')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (requester_agent_id, requester_owner_id) REFERENCES agents (id, owner_id),
  FOREIGN KEY (recipient_agent_id, recipient_owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX handoff_tasks_recipient_idx ON handoff_tasks (recipient_agent_id, updated_at DESC, id DESC);
CREATE INDEX handoff_tasks_requester_idx ON handoff_tasks (requester_agent_id, updated_at DESC, id DESC);
CREATE INDEX handoff_tasks_context_idx ON handoff_tasks (context_id, updated_at DESC, id DESC);

CREATE TABLE handoff_messages (
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  author_owner_id uuid NOT NULL REFERENCES owners (id),
  author_agent_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES handoff_tasks (id),
  role text NOT NULL CHECK (role IN ('ROLE_USER', 'ROLE_AGENT')),
  parts jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (author_owner_id, message_id)
);

CREATE INDEX handoff_messages_task_idx ON handoff_messages (task_id, created_at, message_id);

CREATE TABLE handoff_artifacts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES handoff_tasks (id),
  parts jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX handoff_artifacts_task_idx ON handoff_artifacts (task_id, created_at, id);
