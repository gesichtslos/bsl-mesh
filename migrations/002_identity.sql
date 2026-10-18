CREATE TABLE owners (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  email_verified_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  publication_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners (id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);

CREATE INDEX agents_owner_created_idx ON agents (owner_id, created_at, id);

CREATE TABLE owner_sessions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners (id),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE magic_links (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash),
  CHECK (expires_at > created_at)
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    scopes <@ ARRAY[
      'profile:read',
      'knowledge:read',
      'meetups:read',
      'tools:read',
      'cases:write',
      'evidence:write',
      'meetups:write'
    ]::text[]
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash),
  UNIQUE (id, owner_id),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id),
  FOREIGN KEY (rotated_from_id, owner_id) REFERENCES credentials (id, owner_id),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX credentials_owner_created_idx ON credentials (owner_id, created_at, id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners (id),
  agent_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'agent', 'system')),
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  result text NOT NULL CHECK (result IN ('success', 'denied')),
  request_id text CHECK (request_id IS NULL OR char_length(request_id) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX audit_events_owner_created_idx ON audit_events (owner_id, created_at DESC, id DESC);

CREATE TABLE idempotency_records (
  owner_id uuid NOT NULL REFERENCES owners (id),
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 80),
  idem_key text NOT NULL CHECK (char_length(idem_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL,
  status_code integer NOT NULL CHECK (status_code BETWEEN 0 AND 599),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation, idem_key)
);

CREATE TABLE rate_limit_buckets (
  principal_kind text NOT NULL CHECK (principal_kind IN ('owner', 'agent', 'anonymous')),
  principal_id text NOT NULL CHECK (char_length(principal_id) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (principal_kind, principal_id, window_start)
);

REVOKE ALL ON TABLE
  owners,
  agents,
  owner_sessions,
  magic_links,
  credentials,
  audit_events,
  idempotency_records,
  rate_limit_buckets
FROM PUBLIC;
