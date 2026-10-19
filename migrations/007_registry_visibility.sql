ALTER TABLE component_versions
  ADD COLUMN kind text,
  ADD COLUMN name text,
  ADD COLUMN purpose text,
  ADD COLUMN maintainer text,
  ADD COLUMN upstream_url text,
  ADD COLUMN license text,
  ADD COLUMN presentation text NOT NULL DEFAULT 'catalog';

ALTER TABLE profile_versions
  ADD COLUMN presentation text NOT NULL DEFAULT 'catalog';

UPDATE component_versions AS version
SET kind = component.kind,
    name = component.name,
    purpose = component.purpose,
    maintainer = component.maintainer,
    upstream_url = component.upstream_url,
    license = component.license
FROM environment_components AS component
WHERE component.id = version.component_id;

ALTER TABLE component_versions
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN maintainer SET NOT NULL,
  ALTER COLUMN upstream_url SET NOT NULL,
  ALTER COLUMN license SET NOT NULL;

ALTER TABLE component_versions
  ADD CONSTRAINT component_versions_kind_check CHECK (kind IN ('model', 'rule', 'skill', 'mcp', 'cli', 'analyzer', 'build', 'integration', 'host')),
  ADD CONSTRAINT component_versions_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT component_versions_purpose_check CHECK (char_length(purpose) BETWEEN 1 AND 2000),
  ADD CONSTRAINT component_versions_maintainer_check CHECK (char_length(maintainer) BETWEEN 1 AND 120),
  ADD CONSTRAINT component_versions_license_check CHECK (char_length(license) BETWEEN 1 AND 200),
  ADD CONSTRAINT component_versions_upstream_check CHECK (
    upstream_url ~ '^https://[A-Za-z0-9.-]+/'
    AND upstream_url !~* 'localhost'
    AND upstream_url !~* '127\.0\.0\.1'
    AND upstream_url !~* '169\.254\.'
    AND upstream_url !~* '://10\.'
    AND upstream_url !~* '://192\.168\.'
  ),
  ADD CONSTRAINT component_versions_presentation_check CHECK (presentation IN ('catalog', 'demonstration'));

ALTER TABLE profile_versions
  ADD CONSTRAINT profile_versions_presentation_check CHECK (presentation IN ('catalog', 'demonstration'));

UPDATE component_versions SET presentation = 'demonstration' WHERE source_kind = 'synthetic';
UPDATE profile_versions SET presentation = 'demonstration' WHERE source_kind = 'synthetic';

CREATE OR REPLACE FUNCTION registry_guard_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean;
  status_allowed boolean;
BEGIN
  IF NEW.source_kind = 'synthetic' AND NEW.status = 'published' THEN
    RAISE EXCEPTION 'synthetic registry records cannot be published';
  END IF;
  status_allowed := CASE OLD.status
    WHEN 'draft' THEN NEW.status IN ('draft', 'reviewed', 'published')
    WHEN 'reviewed' THEN NEW.status IN ('draft', 'reviewed', 'published')
    WHEN 'published' THEN NEW.status IN ('published', 'contested', 'security_hold', 'withdrawn', 'superseded')
    WHEN 'contested' THEN NEW.status IN ('contested', 'security_hold', 'withdrawn', 'superseded')
    WHEN 'security_hold' THEN NEW.status IN ('security_hold', 'withdrawn', 'superseded')
    ELSE NEW.status = OLD.status
  END;
  IF NOT status_allowed THEN
    RAISE EXCEPTION 'registry status transition is not allowed';
  END IF;
  IF OLD.status NOT IN ('draft', 'reviewed') THEN
    IF TG_TABLE_NAME = 'profile_versions' THEN
      content_changed := NEW.summary IS DISTINCT FROM OLD.summary
        OR NEW.tasks IS DISTINCT FROM OLD.tasks
        OR NEW.hosts IS DISTINCT FROM OLD.hosts
        OR NEW.applicability IS DISTINCT FROM OLD.applicability
        OR NEW.incompatibilities IS DISTINCT FROM OLD.incompatibilities
        OR NEW.components IS DISTINCT FROM OLD.components
        OR NEW.verification_steps IS DISTINCT FROM OLD.verification_steps
        OR NEW.rollback_steps IS DISTINCT FROM OLD.rollback_steps
        OR NEW.source_uris IS DISTINCT FROM OLD.source_uris
        OR NEW.limitations IS DISTINCT FROM OLD.limitations
        OR NEW.alternatives IS DISTINCT FROM OLD.alternatives
        OR NEW.evidence_quality IS DISTINCT FROM OLD.evidence_quality
        OR NEW.recommendation_level IS DISTINCT FROM OLD.recommendation_level
        OR NEW.conflicts_of_interest IS DISTINCT FROM OLD.conflicts_of_interest
        OR NEW.independent_owner_confirmations IS DISTINCT FROM OLD.independent_owner_confirmations
        OR NEW.presentation IS DISTINCT FROM OLD.presentation
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
        OR NEW.version IS DISTINCT FROM OLD.version;
    ELSE
      content_changed := NEW.summary IS DISTINCT FROM OLD.summary
        OR NEW.hosts IS DISTINCT FROM OLD.hosts
        OR NEW.requirements IS DISTINCT FROM OLD.requirements
        OR NEW.limitations IS DISTINCT FROM OLD.limitations
        OR NEW.risks IS DISTINCT FROM OLD.risks
        OR NEW.provenance IS DISTINCT FROM OLD.provenance
        OR NEW.mcp IS DISTINCT FROM OLD.mcp
        OR NEW.sha256 IS DISTINCT FROM OLD.sha256
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.purpose IS DISTINCT FROM OLD.purpose
        OR NEW.maintainer IS DISTINCT FROM OLD.maintainer
        OR NEW.upstream_url IS DISTINCT FROM OLD.upstream_url
        OR NEW.license IS DISTINCT FROM OLD.license
        OR NEW.presentation IS DISTINCT FROM OLD.presentation
        OR NEW.evidence_quality IS DISTINCT FROM OLD.evidence_quality
        OR NEW.independent_owner_confirmations IS DISTINCT FROM OLD.independent_owner_confirmations
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.component_id IS DISTINCT FROM OLD.component_id
        OR NEW.version IS DISTINCT FROM OLD.version;
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION 'registry content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION registry_forbid_history_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'published registry history cannot be deleted';
  END IF;
  IF TG_TABLE_NAME = 'environment_components' THEN
    IF EXISTS (
      SELECT 1 FROM component_versions
      WHERE component_id = OLD.id AND status NOT IN ('draft', 'reviewed')
    ) THEN
      RAISE EXCEPTION 'published registry history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status NOT IN ('draft', 'reviewed') THEN
    RAISE EXCEPTION 'published registry history cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER profile_versions_no_delete
  BEFORE DELETE ON profile_versions
  FOR EACH ROW EXECUTE FUNCTION registry_forbid_history_delete();

CREATE TRIGGER component_versions_no_delete
  BEFORE DELETE ON component_versions
  FOR EACH ROW EXECUTE FUNCTION registry_forbid_history_delete();

CREATE TRIGGER environment_components_no_delete
  BEFORE DELETE ON environment_components
  FOR EACH ROW EXECUTE FUNCTION registry_forbid_history_delete();

CREATE TRIGGER profile_versions_no_truncate
  BEFORE TRUNCATE ON profile_versions
  FOR EACH STATEMENT EXECUTE FUNCTION registry_forbid_history_delete();

CREATE TRIGGER component_versions_no_truncate
  BEFORE TRUNCATE ON component_versions
  FOR EACH STATEMENT EXECUTE FUNCTION registry_forbid_history_delete();

CREATE FUNCTION registry_guard_component_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.maintainer IS DISTINCT FROM OLD.maintainer
    OR NEW.upstream_url IS DISTINCT FROM OLD.upstream_url
    OR NEW.license IS DISTINCT FROM OLD.license
  THEN
    IF EXISTS (
      SELECT 1 FROM component_versions
      WHERE component_id = OLD.id AND status NOT IN ('draft', 'reviewed')
    ) THEN
      RAISE EXCEPTION 'published component identity cannot change without a new version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER environment_components_identity
  BEFORE UPDATE ON environment_components
  FOR EACH ROW EXECUTE FUNCTION registry_guard_component_identity();
