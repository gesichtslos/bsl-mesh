export const SOURCE_KINDS = ['organic', 'synthetic', 'import'] as const;
export const CLAIM_STATUSES = ['reported', 'supported', 'reproduced', 'contested', 'deprecated'] as const;
export const RELATIONS = ['supports', 'refutes', 'limits'] as const;
export const RESULTS = ['success', 'failure', 'inconclusive'] as const;
export const CONTEXT_MATCHES = ['compatible', 'mismatch', 'insufficient'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type Relation = (typeof RELATIONS)[number];
export type EvidenceResult = (typeof RESULTS)[number];
export type ContextMatch = (typeof CONTEXT_MATCHES)[number];
export type Confidence = 'insufficient_evidence' | 'author_supported' | 'independently_observed' | 'contested';
export type Classification = 'synthetic' | 'unconfirmed' | 'real_evidence';

export type EvidenceAssessmentInput = {
  authorOwnerId: string;
  sourceKind: SourceKind;
  relation: Relation;
  result: EvidenceResult;
  contextMatch: ContextMatch;
  substantive: boolean;
};

export type ClaimAssessment = {
  status: ClaimStatus;
  confidence: Confidence;
  classification: Classification;
};

const CONFIDENCE_BY_STATUS: Record<ClaimStatus, Confidence> = {
  reported: 'insufficient_evidence',
  supported: 'author_supported',
  reproduced: 'independently_observed',
  contested: 'contested',
  deprecated: 'insufficient_evidence',
};

export function assessEvidence(input: {
  claimAuthorOwnerId: string;
  evidenceAuthorOwnerId: string;
  claimText: string;
  method: string;
  observation: string;
  sourceKind: SourceKind;
  relation: Relation;
  result: EvidenceResult;
  contextMatch: ContextMatch;
}): {
  substantive: boolean;
  actorIndependent: boolean;
  countsAsReproduction: boolean;
} {
  const substantive = isSubstantive(input.claimText, input.method, input.observation)
    && input.result !== 'inconclusive';
  const actorIndependent = input.evidenceAuthorOwnerId !== input.claimAuthorOwnerId;
  const countsAsReproduction = substantive
    && actorIndependent
    && input.sourceKind === 'organic'
    && input.relation === 'supports'
    && input.contextMatch === 'compatible';
  return {
    substantive,
    actorIndependent,
    countsAsReproduction,
  };
}

export function evaluateClaim(input: {
  authorOwnerId: string;
  claimSourceKind: SourceKind;
  evidence: readonly EvidenceAssessmentInput[];
}): ClaimAssessment {
  if (input.claimSourceKind !== 'organic') {
    return {
      status: 'reported',
      confidence: 'insufficient_evidence',
      classification: input.claimSourceKind === 'synthetic' ? 'synthetic' : 'unconfirmed',
    };
  }
  const applicable = input.evidence.filter((item) => (
    item.substantive
    && item.sourceKind === 'organic'
    && item.contextMatch === 'compatible'
    && item.result !== 'inconclusive'
  ));
  const refuted = applicable.some((item) => item.relation === 'refutes');
  const supported = applicable.some((item) => item.relation === 'supports');
  const reproduced = applicable.some((item) => (
    item.relation === 'supports' && item.authorOwnerId !== input.authorOwnerId
  ));
  let status: ClaimStatus = 'reported';
  if (refuted) {
    status = 'contested';
  } else if (reproduced) {
    status = 'reproduced';
  } else if (supported) {
    status = 'supported';
  }
  return {
    status,
    confidence: CONFIDENCE_BY_STATUS[status],
    classification: status === 'reported' ? 'unconfirmed' : 'real_evidence',
  };
}

export function isSubstantive(claimText: string, method: string, observation: string): boolean {
  const claim = normalize(claimText);
  const methodText = normalize(method);
  const observationText = normalize(observation);
  if (methodText.length < 20 || observationText.length < 20) {
    return false;
  }
  if (methodText === claim || observationText === claim) {
    return false;
  }
  return true;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
