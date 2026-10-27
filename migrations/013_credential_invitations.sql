CREATE TABLE credential_invitations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners (id),
  agent_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 10
    AND scopes <@ ARRAY[
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
  ),
  invite_hash text NOT NULL CHECK (invite_hash ~ '^[0-9a-f]{64}$'),
  binding_hash text CHECK (binding_hash IS NULL OR binding_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'presented', 'confirmed', 'consumed', 'revoked')),
  expires_at timestamptz NOT NULL,
  credential_ttl_seconds integer NOT NULL CHECK (credential_ttl_seconds BETWEEN 60 AND 86400),
  credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  presented_at timestamptz,
  confirmed_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (invite_hash),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id),
  FOREIGN KEY (credential_id, owner_id) REFERENCES credentials (id, owner_id),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND binding_hash IS NULL AND presented_at IS NULL AND confirmed_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND credential_id IS NULL)
    OR (status = 'presented' AND binding_hash IS NOT NULL AND presented_at IS NOT NULL AND confirmed_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND credential_id IS NULL)
    OR (status = 'confirmed' AND binding_hash IS NOT NULL AND presented_at IS NOT NULL AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND credential_id IS NULL)
    OR (status = 'consumed' AND binding_hash IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL AND credential_id IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL AND credential_id IS NULL)
  )
);

CREATE INDEX credential_invitations_owner_idx
  ON credential_invitations (owner_id, created_at DESC, id DESC);

REVOKE ALL ON TABLE credential_invitations FROM PUBLIC;
