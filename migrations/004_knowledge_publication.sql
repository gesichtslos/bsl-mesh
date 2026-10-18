ALTER TABLE case_revisions
  ADD COLUMN released boolean NOT NULL DEFAULT false;

ALTER TABLE cases
  ADD COLUMN released_revision integer;

ALTER TABLE claim_revisions
  ADD COLUMN released boolean NOT NULL DEFAULT false;

ALTER TABLE claims
  ADD COLUMN released_revision integer,
  ADD COLUMN released_status text,
  ADD COLUMN released_confidence text,
  ADD COLUMN released_classification text;

ALTER TABLE claims
  ADD CONSTRAINT claims_released_status_check
    CHECK (
      released_status IS NULL
      OR released_status IN ('reported', 'supported', 'reproduced', 'contested', 'deprecated')
    ),
  ADD CONSTRAINT claims_released_confidence_check
    CHECK (
      released_confidence IS NULL
      OR released_confidence IN (
        'insufficient_evidence',
        'author_supported',
        'independently_observed',
        'contested'
      )
    ),
  ADD CONSTRAINT claims_released_classification_check
    CHECK (
      released_classification IS NULL
      OR released_classification IN ('synthetic', 'unconfirmed', 'real_evidence')
    );

ALTER TABLE evidence
  ADD COLUMN claim_revision integer,
  ADD COLUMN released boolean NOT NULL DEFAULT false;

UPDATE evidence AS evidence_row
SET claim_revision = claim_row.current_revision
FROM claims AS claim_row
WHERE evidence_row.claim_id = claim_row.id
  AND evidence_row.claim_revision IS NULL;

ALTER TABLE evidence
  ALTER COLUMN claim_revision SET NOT NULL;

ALTER TABLE evidence
  ADD CONSTRAINT evidence_claim_revision_fk
    FOREIGN KEY (claim_id, claim_revision)
    REFERENCES claim_revisions (claim_id, revision);

ALTER TABLE cases
  ADD CONSTRAINT cases_released_revision_fk
    FOREIGN KEY (id, released_revision)
    REFERENCES case_revisions (case_id, revision);

ALTER TABLE claims
  ADD CONSTRAINT claims_released_revision_fk
    FOREIGN KEY (id, released_revision)
    REFERENCES claim_revisions (claim_id, revision);

CREATE INDEX evidence_claim_revision_idx ON evidence (claim_id, claim_revision);
