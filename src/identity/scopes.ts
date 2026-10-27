import { IDENTITY_DETAIL, IdentityError } from './errors.js';

export const READ_SCOPES = ['profile:read', 'knowledge:read', 'meetups:read', 'tools:read', 'handoff:read', 'workspaces:read'] as const;
export const WRITE_SCOPES = ['cases:write', 'evidence:write', 'meetups:write', 'telemetry:write', 'handoff:write', 'workspaces:write'] as const;
export const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES] as const;

export type ReadScope = (typeof READ_SCOPES)[number];
export type WriteScope = (typeof WRITE_SCOPES)[number];
export type Scope = (typeof ALL_SCOPES)[number];

export const DEFAULT_READ_SCOPES: readonly Scope[] = ['profile:read', 'knowledge:read', 'meetups:read', 'tools:read'];

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export function isWriteScope(value: string): value is WriteScope {
  return (WRITE_SCOPES as readonly string[]).includes(value);
}

export function resolveScopes(input: readonly string[] | undefined): Scope[] {
  return collectScopes(input, ALL_SCOPES, true);
}

export function resolveInvitationScopes(input: readonly string[]): Scope[] {
  const allowed = ALL_SCOPES.filter((scope) => scope !== 'workspaces:read' && scope !== 'workspaces:write');
  return collectScopes(input, allowed, false);
}

function collectScopes(input: readonly string[] | undefined, allowed: readonly Scope[], useDefault: boolean): Scope[] {
  if (input === undefined) {
    if (!useDefault) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    return [...DEFAULT_READ_SCOPES];
  }
  if (input.length === 0 || input.length > allowed.length) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  const scopes: Scope[] = [];
  for (const item of input) {
    if (!(allowed as readonly string[]).includes(item) || scopes.includes(item as Scope)) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    scopes.push(item as Scope);
  }
  return scopes;
}
