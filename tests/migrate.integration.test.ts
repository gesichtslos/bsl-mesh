import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';
import { Client } from 'pg';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildDatabaseUrl, decodedDatabasePassword, resolveDatabaseUrl } from '../src/db/database-url.js';
import { MIGRATION_ADVISORY_LOCK_KEY, MigrationLockError, migrate, migrationsDirectory } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  resetDisposableSchema,
  TestDatabaseGuardError,
  type SqlClient,
} from '../src/db/test-database.js';
import { redactDatabaseUrl } from '../src/db/redact.js';
import type { Pool } from 'pg';

function sqlClient(pool: Pool): SqlClient {
  return {
    query(sql, params) {
      if (params === undefined) {
        return pool.query(sql);
      }
      return pool.query(sql, [...params]);
    },
  };
}

test('refuses the application database before SQL', async () => {
  const applicationUrl = process.env['DATABASE_URL'];
  if (applicationUrl === undefined || applicationUrl === '') {
    throw new Error('DATABASE_URL is required to prove the application database is refused.');
  }
  let calls = 0;
  const client: SqlClient = {
    async query() {
      calls += 1;
      return { rows: [] };
    },
  };
  await expect(resetDisposableSchema(client, {
    NODE_ENV: 'test',
    DATABASE_URL: applicationUrl,
    TEST_DATABASE_URL: applicationUrl,
  })).rejects.toBeInstanceOf(TestDatabaseGuardError);
  expect(calls).toBe(0);
});

test('migrations apply once on the disposable database and readiness sees it', async () => {
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (testUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  const pool = createPool(testUrl);
  try {
    await resetDisposableSchema(sqlClient(pool), process.env);
    const first = await migrate(pool);
    const second = await migrate(pool);
    expect(first.applied).toEqual(['001_app_meta.sql', '002_identity.sql', '003_knowledge.sql']);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_app_meta.sql', '002_identity.sql', '003_knowledge.sql']);

    const migrations = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM schema_migrations');
    const meta = await pool.query<{ service_name: string; count: number }>(
      'SELECT service_name, count(*)::int AS count FROM app_meta GROUP BY service_name',
    );
    expect(migrations.rows[0]?.count).toBe(3);
    expect(meta.rows[0]?.service_name).toBe('bsl-mesh');
    expect(meta.rows[0]?.count).toBe(1);

    const app = await buildApp(loadConfig({
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_URL: testUrl,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    }));
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
});

test('the tester cannot open the application database', async () => {
  const applicationUrl = process.env['DATABASE_URL'];
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (applicationUrl === undefined || testUrl === undefined) {
    throw new Error('DATABASE_URL and TEST_DATABASE_URL are required.');
  }
  const application = new URL(applicationUrl);
  const tester = new URL(testUrl);
  tester.pathname = application.pathname;
  const pool = createPool(tester.href);
  try {
    await pool.query('SELECT 1');
    throw new Error('tester connected to the application database');
  } catch (error) {
    if (error instanceof Error && error.message === 'tester connected to the application database') {
      throw error;
    }
    const message = redactDatabaseUrl(error instanceof Error ? error.message : '');
    expect(message.toLowerCase()).toMatch(/permission denied|not permitted/);
  } finally {
    await pool.end();
  }
});

test('the application role is not a superuser and migrations are idempotent on an empty database', async () => {
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  if (adminUrl === undefined || adminUrl === '') {
    throw new Error('ADMIN_DATABASE_URL is required.');
  }
  const applicationUrl = resolveDatabaseUrl(process.env);
  const application = new URL(applicationUrl);
  const identityPool = createPool(applicationUrl);
  try {
    const identity = await identityPool.query<{ username: string; is_superuser: boolean }>(
      `SELECT current_user AS username, rolsuper AS is_superuser
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    expect(identity.rows[0]?.username).toBe('bslmesh_app');
    expect(identity.rows[0]?.is_superuser).toBe(false);
  } finally {
    await identityPool.end();
  }

  const databaseName = 'bslmesh_migrate_test';
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${databaseName} OWNER bslmesh_app`);
    await admin.query(`REVOKE ALL ON DATABASE ${databaseName} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${databaseName} TO bslmesh_app`);
  } finally {
    await admin.end();
  }

  const freshUrl = buildDatabaseUrl({
    username: 'bslmesh_app',
    password: decodedDatabasePassword(applicationUrl),
    host: application.hostname,
    port: Number(application.port || '5432'),
    database: databaseName,
  });
  const pool = createPool(freshUrl);
  try {
    const source = migrationsDirectory();
    const partial = await mkdtemp(path.join(tmpdir(), 'bslmesh-migrate-'));
    try {
      await copyFile(path.join(source, '001_app_meta.sql'), path.join(partial, '001_app_meta.sql'));
      const baseline = await migrate(pool, partial);
      const upgraded = await migrate(pool, source);
      const repeated = await migrate(pool, source);
      expect(baseline.applied).toEqual(['001_app_meta.sql']);
      expect(baseline.skipped).toEqual([]);
      expect(upgraded.applied).toEqual(['002_identity.sql', '003_knowledge.sql']);
      expect(upgraded.skipped).toEqual(['001_app_meta.sql']);
      expect(repeated.applied).toEqual([]);
      expect(repeated.skipped).toEqual(['001_app_meta.sql', '002_identity.sql', '003_knowledge.sql']);
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  } finally {
    await pool.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});

test('a concurrent migration does not enter the schema change', async () => {
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (testUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  const holder = createPool(testUrl);
  const runner = createPool(testUrl);
  const client = await holder.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await expect(migrate(runner)).rejects.toBeInstanceOf(MigrationLockError);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    client.release();
    await holder.end();
    await runner.end();
  }
});

test('a password with reserved characters still authenticates', async () => {
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (adminUrl === undefined || testUrl === undefined) {
    throw new Error('ADMIN_DATABASE_URL and TEST_DATABASE_URL are required.');
  }
  const password = 'a@b:c/d#e%f g';
  const role = 'bslmesh_urlcheck';
  const admin = new Client({ connectionString: adminUrl });
  const databaseName = new URL(testUrl).pathname.replace(/^\//, '');
  await admin.connect();
  await admin.query(`REVOKE ALL ON DATABASE ${databaseName} FROM bslmesh_urlcheck`).catch(() => undefined);
  await admin.query('DROP ROLE IF EXISTS bslmesh_urlcheck');
  const clientUrl = buildDatabaseUrl({
    username: role,
    password,
    host: new URL(adminUrl).hostname,
    port: Number(new URL(adminUrl).port || '5432'),
    database: databaseName,
  });
  const client = new Client({ connectionString: clientUrl });
  try {
    const formatted = await admin.query<{ command: string }>(
      `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB PASSWORD %L', $1::text, $2::text) AS command`,
      [role, password],
    );
    const command = formatted.rows[0]?.command;
    if (command === undefined) {
      throw new Error('Could not build the URL-check role statement.');
    }
    await admin.query(command);
    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${databaseName} TO ${role}`);
    await client.connect();
    const identity = await client.query<{ username: string }>('SELECT current_user AS username');
    expect(identity.rows[0]?.username).toBe(role);
  } finally {
    await client.end().catch(() => undefined);
    await admin.query(`REVOKE ALL ON DATABASE ${databaseName} FROM bslmesh_urlcheck`).catch(() => undefined);
    await admin.query('DROP ROLE IF EXISTS bslmesh_urlcheck');
    await admin.end();
  }
});
