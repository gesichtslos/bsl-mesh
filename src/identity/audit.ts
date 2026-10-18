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
  return detail;
}
