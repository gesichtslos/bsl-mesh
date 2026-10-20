import type { Measurement } from './types.js';

const TOKEN_FIELDS = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'],
  ['totalTokens', 'total_tokens'],
  ['reasoningTokens', 'reasoning_tokens'],
] as const;

function knownToken(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
    return null;
  }
  return value;
}

export function measurementsFromSdkUsage(usage: unknown): Measurement[] {
  const record = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : null;
  return TOKEN_FIELDS.map(([field, name]) => {
    const value = record === null ? null : knownToken(record[field]);
    if (value === null) {
      return {
        name,
        unit: 'token' as const,
        value: null,
        state: 'unknown' as const,
        provenance: 'unknown' as const,
        source: 'cursor-sdk' as const,
      };
    }
    return {
      name,
      unit: 'token' as const,
      value,
      state: 'known' as const,
      provenance: 'provider_reported' as const,
      source: 'cursor-sdk' as const,
    };
  });
}

export function sdkCost(usage: unknown): Measurement {
  const record = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : null;
  const value = record === null ? null : record['costUsd'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    return {
      name: 'cost_usd',
      unit: 'usd',
      value: null,
      state: 'unknown',
      provenance: 'unknown',
      source: 'cursor-sdk',
    };
  }
  return {
    name: 'cost_usd',
    unit: 'usd',
    value,
    state: 'known',
    provenance: 'provider_reported',
    source: 'cursor-sdk',
  };
}
