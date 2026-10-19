CREATE OR REPLACE FUNCTION registry_guard_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean;
  status_allowed boolean;
BEGIN
  IF NEW.source_kind = 'synthetic' AND NEW.status IN ('published', 'contested', 'withdrawn', 'superseded') THEN
    RAISE EXCEPTION 'synthetic registry records cannot be public';
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
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.last_reviewed_at IS DISTINCT FROM OLD.last_reviewed_at
        OR NEW.review_due_at IS DISTINCT FROM OLD.review_due_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at;
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
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.last_reviewed_at IS DISTINCT FROM OLD.last_reviewed_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at;
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION 'registry content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION registry_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('draft', 'reviewed', 'published') THEN
    RAISE EXCEPTION 'public registry history must start from publication';
  END IF;
  IF NEW.source_kind = 'synthetic' AND NEW.status = 'published' THEN
    RAISE EXCEPTION 'synthetic registry records cannot be public';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE profile_versions
  ADD CONSTRAINT profile_versions_synthetic_private_check
  CHECK (NOT (source_kind = 'synthetic' AND status IN ('published', 'contested', 'withdrawn', 'superseded')));

ALTER TABLE component_versions
  ADD CONSTRAINT component_versions_synthetic_private_check
  CHECK (NOT (source_kind = 'synthetic' AND status IN ('published', 'contested', 'withdrawn', 'superseded')));
