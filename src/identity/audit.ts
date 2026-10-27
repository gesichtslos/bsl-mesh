export const AUDIT_REASONS = ['scope', 'publication', 'impersonation'] as const;

export type AuditReason = (typeof AUDIT_REASONS)[number];

export type AuditDetail = {
  agent_id?: string;
  credential_id?: string;
  scopes?: readonly string[];
  rotated_from_id?: string;
  scope?: string;
  reason?: AuditReason;
  claimed_agent_id?: string;
  publication_enabled?: boolean;
  case_id?: string;
  claim_id?: string;
  evidence_id?: string;
  visibility?: string;
  report_id?: string;
  source_kind?: 'organic' | 'synthetic';
  task_id?: string;
  peer_agent_id?: string;
  invitation_id?: string;
};

export function auditDetail(input: Record<string, unknown>): AuditDetail {
  const detail: AuditDetail = {};
  if (typeof input['agent_id'] === 'string') {
    detail.agent_id = input['agent_id'];
  }
  if (typeof input['credential_id'] === 'string') {
    detail.credential_id = input['credential_id'];
  }
  if (Array.isArray(input['scopes']) && input['scopes'].every((item) => typeof item === 'string')) {
    detail.scopes = [...input['scopes']];
  }
  if (typeof input['rotated_from_id'] === 'string') {
    detail.rotated_from_id = input['rotated_from_id'];
  }
  if (typeof input['scope'] === 'string') {
    detail.scope = input['scope'];
  }
  const reason = input['reason'];
  if (reason === 'scope' || reason === 'publication' || reason === 'impersonation') {
    detail.reason = reason;
  }
  if (typeof input['claimed_agent_id'] === 'string') {
    detail.claimed_agent_id = input['claimed_agent_id'];
  }
  if (typeof input['publication_enabled'] === 'boolean') {
    detail.publication_enabled = input['publication_enabled'];
  }
  if (typeof input['case_id'] === 'string') {
    detail.case_id = input['case_id'];
  }
  if (typeof input['claim_id'] === 'string') {
    detail.claim_id = input['claim_id'];
  }
  if (typeof input['evidence_id'] === 'string') {
    detail.evidence_id = input['evidence_id'];
  }
  if (typeof input['report_id'] === 'string') {
    detail.report_id = input['report_id'];
  }
  if (typeof input['task_id'] === 'string') {
    detail.task_id = input['task_id'];
  }
  if (typeof input['peer_agent_id'] === 'string') {
    detail.peer_agent_id = input['peer_agent_id'];
  }
  if (typeof input['invitation_id'] === 'string') {
    detail.invitation_id = input['invitation_id'];
  }
  if (input['source_kind'] === 'organic' || input['source_kind'] === 'synthetic') {
    detail.source_kind = input['source_kind'];
  }
  if (input['visibility'] === 'public' || input['visibility'] === 'members' || input['visibility'] === 'private') {
    detail.visibility = input['visibility'];
  }
  return detail;
}
