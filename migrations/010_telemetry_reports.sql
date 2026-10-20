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
    'cases:write',
    'evidence:write',
    'meetups:write',
    'telemetry:write'
  ]::text[]
);

CREATE TABLE telemetry_reports (
  owner_id uuid NOT NULL REFERENCES owners (id),
  agent_id uuid NOT NULL,
  report_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic')),
  schema_version text NOT NULL CHECK (schema_version = '1'),
  document jsonb NOT NULL,
  acceptance text NOT NULL CHECK (acceptance = 'stored_unverified'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, report_id),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX telemetry_reports_owner_created_idx
  ON telemetry_reports (owner_id, created_at DESC, report_id DESC);

REVOKE ALL ON TABLE telemetry_reports FROM PUBLIC;
