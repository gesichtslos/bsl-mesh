import { Pool } from 'pg';

import { redactDatabaseUrl } from './redact.js';

export function createPool(
  databaseUrl: string,
  onIdleError?: (message: string) => void,
): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (error: Error) => {
    onIdleError?.(redactDatabaseUrl(error.message));
  });
  return pool;
}
