import { createHash } from 'node:crypto';

export function anonymousRateKey(address: string): string {
  const normalized = address.trim().slice(0, 80);
  const identity = normalized === '' ? 'unknown' : normalized;
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}
