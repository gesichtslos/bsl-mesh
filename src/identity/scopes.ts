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
  if (input === undefined) {
    return [...DEFAULT_READ_SCOPES];
  }
  if (input.length === 0 || input.length > ALL_SCOPES.length) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  const scopes: Scope[] = [];
  for (const item of input) {
    if (!isScope(item) || scopes.includes(item)) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    scopes.push(item);
  }
  return scopes;
}
