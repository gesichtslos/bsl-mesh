import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { redactDatabaseUrl } from './redact.js';

const MIGRATION_NAME = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
export const MIGRATION_ADVISORY_LOCK_KEY = '872013001';

export class MigrationLockError extends Error {
  constructor() {
    super('Another migration is already running.');
    this.name = 'MigrationLockError';
  }
}

export type MigrateResult = {
  applied: string[];
  skipped: string[];
};

export function migrationsDirectory(): string {
  return process.env['MIGRATIONS_DIR'] ?? path.resolve(process.cwd(), 'migrations');
}

export async function migrate(pool: Pool, directory = migrationsDirectory()): Promise<MigrateResult> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort((left, right) => left.localeCompare(right));
  const applied: string[] = [];
  const skipped: string[] = [];
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new MigrationLockError();
    }
    locked = true;
    await ensureMigrationsTable(client);
    for (const name of names) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [name],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.checksum !== checksum) {
          throw new Error(`Migration ${name} changed after it was applied.`);
        }
        skipped.push(name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(redactDatabaseUrl(error instanceof Error ? error.message : 'migration failed'));
      }
      applied.push(name);
    }
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    }
    client.release();
  }
  return { applied, skipped };
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}
