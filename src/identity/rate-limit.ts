import type { Pool, PoolClient } from 'pg';

import { IDENTITY_DETAIL, IdentityError } from './errors.js';

export type RatePrincipal = {
  kind: 'owner' | 'agent' | 'anonymous';
  id: string;
  limit: number;
};

const MINUTE_MS = 60_000;
export const MAGIC_LINK_EMAIL_LIMIT = 10;

export function rateWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function retryAfterSeconds(now: Date): number {
  const remaining = MINUTE_MS - (now.getTime() - rateWindowStart(now).getTime());
  return Math.max(1, Math.ceil(remaining / 1000));
}

export async function consumeRateLimit(pool: Pool, principals: readonly RatePrincipal[], now: Date): Promise<void> {
  if (principals.length === 0) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await incrementLimits(client, principals, now);
    await client.query('COMMIT');
  } catch (error) {
    if (!(error instanceof IdentityError)) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function incrementLimits(client: PoolClient, principals: readonly RatePrincipal[], now: Date): Promise<void> {
  const start = rateWindowStart(now);
  for (const principal of principals) {
    const result = await client.query<{ request_count: number }>(
      `INSERT INTO rate_limit_buckets (principal_kind, principal_id, window_start, request_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (principal_kind, principal_id, window_start)
       DO UPDATE SET request_count = rate_limit_buckets.request_count + 1
       RETURNING request_count`,
      [principal.kind, principal.id, start],
    );
    const count = result.rows[0]?.request_count;
    if (count === undefined || count > principal.limit) {
      await client.query('COMMIT');
      throw new IdentityError(429, 'Too Many Requests', IDENTITY_DETAIL.rateLimit, {
        'retry-after': String(retryAfterSeconds(now)),
      });
    }
  }
}
