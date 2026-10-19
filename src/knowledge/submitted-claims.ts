import type { KnowledgeContext } from './context.js';

export type SubmittedClaim = {
  text: string;
  context: KnowledgeContext;
  evidenceCount: number;
};

export function submittedClaimsMatch(
  expected: readonly SubmittedClaim[],
  stored: readonly SubmittedClaim[],
): boolean {
  if (expected.length !== stored.length) {
    return false;
  }
  const remaining = stored.map(claimSignature);
  for (const claim of expected) {
    const signature = claimSignature(claim);
    const index = remaining.indexOf(signature);
    if (index < 0) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function claimSignature(claim: SubmittedClaim): string {
  const context = claim.context;
  return JSON.stringify([
    claim.text,
    claim.evidenceCount,
    context.platform_version,
    context.compatibility_mode,
    context.application_mode,
    context.form_type,
    context.client_type,
    context.os,
    context.dbms,
    context.configuration_family,
    context.tool_name,
    context.tool_version,
  ]);
}
