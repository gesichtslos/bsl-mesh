ALTER TABLE evidence
  ADD COLUMN status_eligible boolean NOT NULL DEFAULT true;

WITH candidates AS (
  SELECT
    evidence_row.id AS evidence_id,
    revision_row.revision,
    revision_row.created_at,
    count(*) OVER (
      PARTITION BY evidence_row.id, revision_row.created_at
    ) AS tied_at_timestamp
  FROM evidence AS evidence_row
  JOIN claim_revisions AS revision_row
    ON revision_row.claim_id = evidence_row.claim_id
   AND revision_row.created_at <= evidence_row.created_at
), chosen AS (
  SELECT evidence_id, revision, tied_at_timestamp
  FROM (
    SELECT
      candidates.*,
      row_number() OVER (
        PARTITION BY evidence_id
        ORDER BY created_at DESC, revision DESC
      ) AS rank
    FROM candidates
  ) AS ordered
  WHERE rank = 1
)
UPDATE evidence AS evidence_row
SET
  claim_revision = CASE
    WHEN chosen.tied_at_timestamp = 1 THEN chosen.revision
    ELSE evidence_row.claim_revision
  END,
  status_eligible = chosen.tied_at_timestamp = 1
FROM chosen
WHERE evidence_row.id = chosen.evidence_id;

UPDATE evidence AS evidence_row
SET status_eligible = false
WHERE NOT EXISTS (
  SELECT 1
  FROM claim_revisions AS revision_row
  WHERE revision_row.claim_id = evidence_row.claim_id
    AND revision_row.created_at <= evidence_row.created_at
);

UPDATE claims AS claim_row
SET
  status = assessment.status,
  confidence = assessment.confidence,
  classification = assessment.classification,
  released_status = CASE
    WHEN claim_row.released_revision = claim_row.current_revision THEN assessment.status
    ELSE claim_row.released_status
  END,
  released_confidence = CASE
    WHEN claim_row.released_revision = claim_row.current_revision THEN assessment.confidence
    ELSE claim_row.released_confidence
  END,
  released_classification = CASE
    WHEN claim_row.released_revision = claim_row.current_revision THEN assessment.classification
    ELSE claim_row.released_classification
  END
FROM (
  SELECT
    claim_row.id,
    CASE
      WHEN claim_row.source_kind <> 'organic' THEN 'reported'
      WHEN eligible.refuted THEN 'contested'
      WHEN eligible.reproduced THEN 'reproduced'
      WHEN eligible.supported THEN 'supported'
      ELSE 'reported'
    END AS status,
    CASE
      WHEN claim_row.source_kind <> 'organic' THEN 'insufficient_evidence'
      WHEN eligible.refuted THEN 'contested'
      WHEN eligible.reproduced THEN 'independently_observed'
      WHEN eligible.supported THEN 'author_supported'
      ELSE 'insufficient_evidence'
    END AS confidence,
    CASE
      WHEN claim_row.source_kind = 'synthetic' THEN 'synthetic'
      WHEN claim_row.source_kind <> 'organic' OR NOT (
        eligible.refuted OR eligible.reproduced OR eligible.supported
      ) THEN 'unconfirmed'
      ELSE 'real_evidence'
    END AS classification
  FROM claims AS claim_row
  JOIN LATERAL (
    SELECT
      EXISTS (
        SELECT 1
        FROM evidence AS evidence_row
        WHERE evidence_row.claim_id = claim_row.id
          AND evidence_row.claim_revision = claim_row.current_revision
          AND evidence_row.status_eligible
          AND evidence_row.substantive
          AND evidence_row.source_kind = 'organic'
          AND evidence_row.context_match = 'compatible'
          AND evidence_row.result <> 'inconclusive'
          AND evidence_row.relation = 'refutes'
      ) AS refuted,
      EXISTS (
        SELECT 1
        FROM evidence AS evidence_row
        WHERE evidence_row.claim_id = claim_row.id
          AND evidence_row.claim_revision = claim_row.current_revision
          AND evidence_row.status_eligible
          AND evidence_row.substantive
          AND evidence_row.source_kind = 'organic'
          AND evidence_row.context_match = 'compatible'
          AND evidence_row.result <> 'inconclusive'
          AND evidence_row.relation = 'supports'
          AND evidence_row.author_owner_id <> claim_row.author_owner_id
      ) AS reproduced,
      EXISTS (
        SELECT 1
        FROM evidence AS evidence_row
        WHERE evidence_row.claim_id = claim_row.id
          AND evidence_row.claim_revision = claim_row.current_revision
          AND evidence_row.status_eligible
          AND evidence_row.substantive
          AND evidence_row.source_kind = 'organic'
          AND evidence_row.context_match = 'compatible'
          AND evidence_row.result <> 'inconclusive'
          AND evidence_row.relation = 'supports'
      ) AS supported
  ) AS eligible ON true
) AS assessment
WHERE claim_row.id = assessment.id;
