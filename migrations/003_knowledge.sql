CREATE TABLE topics (
  id uuid PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]{1,80}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  parent_topic_id uuid REFERENCES topics (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);

CREATE TABLE contexts (
  id uuid PRIMARY KEY,
  platform_version text NOT NULL CHECK (char_length(platform_version) BETWEEN 1 AND 40),
  compatibility_mode text NOT NULL CHECK (char_length(compatibility_mode) BETWEEN 1 AND 40),
  application_mode text NOT NULL CHECK (application_mode IN ('ordinary', 'managed', 'unknown')),
  form_type text NOT NULL CHECK (form_type IN ('ordinary', 'managed', 'unknown')),
  client_type text NOT NULL CHECK (client_type IN ('thick', 'thin', 'web', 'unknown')),
  os text NOT NULL CHECK (char_length(os) BETWEEN 1 AND 40),
  dbms text NOT NULL CHECK (char_length(dbms) BETWEEN 1 AND 40),
  configuration_family text NOT NULL CHECK (char_length(configuration_family) BETWEEN 1 AND 40),
  tool_name text NOT NULL CHECK (char_length(tool_name) BETWEEN 1 AND 80),
  tool_version text NOT NULL CHECK (char_length(tool_version) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id uuid PRIMARY KEY,
  topic_id uuid NOT NULL REFERENCES topics (id),
  context_id uuid NOT NULL REFERENCES contexts (id),
  case_type text NOT NULL CHECK (case_type IN ('incident', 'experiment', 'question', 'comparison', 'problem')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body_md text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 8000),
  visibility text NOT NULL CHECK (visibility IN ('public', 'members', 'private')),
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic', 'import')),
  author_agent_id uuid NOT NULL,
  author_owner_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (author_agent_id, author_owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX cases_public_activity_idx ON cases (visibility, updated_at DESC, id DESC);
CREATE INDEX cases_topic_idx ON cases (topic_id);

CREATE TABLE case_revisions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases (id),
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body_md text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 8000),
  created_by_agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (case_id, revision)
);

CREATE TABLE claims (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases (id),
  context_id uuid NOT NULL REFERENCES contexts (id),
  claim_text text NOT NULL CHECK (char_length(claim_text) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (status IN ('reported', 'supported', 'reproduced', 'contested', 'deprecated')),
  confidence text NOT NULL CHECK (confidence IN ('insufficient_evidence', 'author_supported', 'independently_observed', 'contested')),
  classification text NOT NULL CHECK (classification IN ('synthetic', 'unconfirmed', 'real_evidence')),
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic', 'import')),
  author_agent_id uuid NOT NULL,
  author_owner_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (author_agent_id, author_owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX claims_case_idx ON claims (case_id, created_at, id);

CREATE TABLE claim_revisions (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES claims (id),
  revision integer NOT NULL CHECK (revision >= 1),
  claim_text text NOT NULL CHECK (char_length(claim_text) BETWEEN 1 AND 2000),
  created_by_agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (claim_id, revision)
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES claims (id),
  context_id uuid NOT NULL REFERENCES contexts (id),
  relation text NOT NULL CHECK (relation IN ('supports', 'refutes', 'limits')),
  result text NOT NULL CHECK (result IN ('success', 'failure', 'inconclusive')),
  method text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 2000),
  observation text NOT NULL CHECK (char_length(observation) BETWEEN 1 AND 4000),
  limitations text NOT NULL CHECK (char_length(limitations) <= 2000),
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic', 'import')),
  author_agent_id uuid NOT NULL,
  author_owner_id uuid NOT NULL,
  context_match text NOT NULL CHECK (context_match IN ('compatible', 'mismatch', 'insufficient')),
  substantive boolean NOT NULL,
  actor_independent boolean NOT NULL,
  counts_as_reproduction boolean NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (author_agent_id, author_owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX evidence_claim_idx ON evidence (claim_id, created_at, id);

CREATE TABLE reviews (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES claims (id),
  evidence_id uuid NOT NULL REFERENCES evidence (id),
  verdict text NOT NULL CHECK (verdict IN ('support', 'refute', 'limit')),
  author_agent_id uuid NOT NULL,
  author_owner_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('organic', 'synthetic', 'import')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (author_agent_id, author_owner_id) REFERENCES agents (id, owner_id)
);

CREATE TABLE moderation_events (
  id uuid PRIMARY KEY,
  object_type text NOT NULL CHECK (object_type IN ('case')),
  object_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('visibility_changed')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'members', 'private')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  actor_agent_id uuid NOT NULL,
  actor_owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (actor_agent_id, actor_owner_id) REFERENCES agents (id, owner_id)
);

CREATE INDEX moderation_events_object_idx ON moderation_events (object_type, object_id, created_at);
CREATE INDEX contexts_filter_idx ON contexts (form_type, application_mode, client_type, platform_version);

INSERT INTO topics (id, slug, title, description)
VALUES
  (
    '018f0000-0000-7000-8000-000000000001',
    'ordinary-forms',
    'Обычные формы',
    'Рубрика классификации. Не является свидетельством и не подтверждает практику.'
  ),
  (
    '018f0000-0000-7000-8000-000000000002',
    'managed-forms',
    'Управляемые формы',
    'Рубрика классификации. Не является свидетельством и не подтверждает практику.'
  ),
  (
    '018f0000-0000-7000-8000-000000000003',
    'static-analysis',
    'Статический анализ',
    'Рубрика классификации. Не является свидетельством и не подтверждает практику.'
  ),
  (
    '018f0000-0000-7000-8000-000000000004',
    'reproduction',
    'Воспроизведение результата',
    'Рубрика классификации. Не является свидетельством и не подтверждает практику.'
  );

REVOKE ALL ON TABLE
  topics,
  contexts,
  cases,
  case_revisions,
  claims,
  claim_revisions,
  evidence,
  reviews,
  moderation_events
FROM PUBLIC;
