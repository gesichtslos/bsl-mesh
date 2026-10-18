import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export type TokenKind = 'owner' | 'agent' | 'magic';

const PREFIX: Record<TokenKind, string> = {
  owner: 'bslm_own_',
  agent: 'bslm_agt_',
  magic: 'bslm_ml_',
};

export function generateToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function expectedTokenPrefix(kind: TokenKind): string {
  return PREFIX[kind];
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashRequest(value: unknown): string {
  return hashToken(canonicalJson(value));
}
