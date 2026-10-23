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
    expect(first.applied).toEqual([
      '001_app_meta.sql',
      '002_identity.sql',
      '003_knowledge.sql',
      '004_knowledge_publication.sql',
      '005_evidence_revision_attribution.sql',
      '006_environment_registry.sql',
      '007_registry_visibility.sql',
      '008_registry_snapshot_times.sql',
      '009_registry_publication_gate.sql',
      '010_telemetry_reports.sql',
      '011_handoff.sql',
    ]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([
      '001_app_meta.sql',
      '002_identity.sql',
      '003_knowledge.sql',
      '004_knowledge_publication.sql',
      '005_evidence_revision_attribution.sql',
      '006_environment_registry.sql',
      '007_registry_visibility.sql',
      '008_registry_snapshot_times.sql',
      '009_registry_publication_gate.sql',
      '010_telemetry_reports.sql',
      '011_handoff.sql',
    ]);

    const migrations = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM schema_migrations');
    const meta = await pool.query<{ service_name: string; count: number }>(
      'SELECT service_name, count(*)::int AS count FROM app_meta GROUP BY service_name',
    );
    expect(migrations.rows[0]?.count).toBe(11);
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
      expect(upgraded.applied).toEqual([
        '002_identity.sql',
        '003_knowledge.sql',
        '004_knowledge_publication.sql',
        '005_evidence_revision_attribution.sql',
        '006_environment_registry.sql',
      '007_registry_visibility.sql',
      '008_registry_snapshot_times.sql',
      '009_registry_publication_gate.sql',
      '010_telemetry_reports.sql',
      '011_handoff.sql',
      ]);
      expect(upgraded.skipped).toEqual(['001_app_meta.sql']);
      expect(repeated.applied).toEqual([]);
      expect(repeated.skipped).toEqual([
        '001_app_meta.sql',
        '002_identity.sql',
        '003_knowledge.sql',
        '004_knowledge_publication.sql',
        '005_evidence_revision_attribution.sql',
        '006_environment_registry.sql',
      '007_registry_visibility.sql',
      '008_registry_snapshot_times.sql',
      '009_registry_publication_gate.sql',
      '010_telemetry_reports.sql',
      '011_handoff.sql',
      ]);
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

test('historical evidence stays on the revision that existed when it was recorded', async () => {
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  if (adminUrl === undefined || adminUrl === '') {
    throw new Error('ADMIN_DATABASE_URL is required.');
  }
  const applicationUrl = resolveDatabaseUrl(process.env);
  const application = new URL(applicationUrl);
  const databaseName = 'bslmesh_evidence_mig';
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
  const source = migrationsDirectory();
  const partial = await mkdtemp(path.join(tmpdir(), 'bslmesh-evidence-'));
  const pool = createPool(freshUrl);
  try {
    await copyFile(path.join(source, '001_app_meta.sql'), path.join(partial, '001_app_meta.sql'));
    await copyFile(path.join(source, '002_identity.sql'), path.join(partial, '002_identity.sql'));
    await copyFile(path.join(source, '003_knowledge.sql'), path.join(partial, '003_knowledge.sql'));
    await migrate(pool, partial);
    await pool.query(
      `INSERT INTO owners (id, display_name, email, email_verified_at, status)
       VALUES
         ('018f1000-0000-7000-8000-000000000001', 'Synthetic Owner', 'evidence-mig@example.test', '2026-01-01T00:00:00Z', 'active'),
         ('018f1000-0000-7000-8000-000000000002', 'Synthetic Other', 'evidence-mig-other@example.test', '2026-01-01T00:00:00Z', 'active')`,
    );
    await pool.query(
      `INSERT INTO agents (id, owner_id, display_name, status)
       VALUES
         ('018f1000-0000-7000-8000-000000000011', '018f1000-0000-7000-8000-000000000001', 'Synthetic Agent', 'active'),
         ('018f1000-0000-7000-8000-000000000012', '018f1000-0000-7000-8000-000000000002', 'Synthetic Other Agent', 'active')`,
    );
    await pool.query(
      `INSERT INTO contexts (
         id, platform_version, compatibility_mode, application_mode, form_type, client_type,
         os, dbms, configuration_family, tool_name, tool_version, created_at
       ) VALUES (
         '018f1000-0000-7000-8000-000000000021', '8.3.27', '8.3.19', 'ordinary', 'ordinary', 'thick',
         'Windows', 'PostgreSQL', 'custom', 'bsl-language-server', '0.24.2', '2026-01-01T00:00:00Z'
       )`,
    );
    await pool.query(
      `INSERT INTO cases (
         id, topic_id, context_id, case_type, title, body_md, visibility, source_kind,
         author_agent_id, author_owner_id, current_revision, created_at, updated_at
       ) VALUES (
         '018f1000-0000-7000-8000-000000000031', '018f0000-0000-7000-8000-000000000004',
         '018f1000-0000-7000-8000-000000000021', 'experiment', 'Historical attribution',
         'Synthetic migration fixture.', 'private', 'organic',
         '018f1000-0000-7000-8000-000000000011', '018f1000-0000-7000-8000-000000000001',
         1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
       )`,
    );
    await pool.query(
      `INSERT INTO claims (
         id, case_id, context_id, claim_text, status, confidence, classification, source_kind,
         author_agent_id, author_owner_id, current_revision, created_at, updated_at
       ) VALUES
         (
           '018f1000-0000-7000-8000-000000000041', '018f1000-0000-7000-8000-000000000031',
           '018f1000-0000-7000-8000-000000000021', 'Форма не открывается.',
           'reproduced', 'independently_observed', 'real_evidence', 'organic',
           '018f1000-0000-7000-8000-000000000011', '018f1000-0000-7000-8000-000000000001',
           2, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
         ),
         (
           '018f1000-0000-7000-8000-000000000042', '018f1000-0000-7000-8000-000000000031',
           '018f1000-0000-7000-8000-000000000021', 'Неоднозначное утверждение.',
           'reproduced', 'independently_observed', 'real_evidence', 'organic',
           '018f1000-0000-7000-8000-000000000011', '018f1000-0000-7000-8000-000000000001',
           2, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
         )`,
    );
    await pool.query(
      `INSERT INTO claim_revisions (id, claim_id, revision, claim_text, created_by_agent_id, created_at)
       VALUES
         ('018f1000-0000-7000-8000-000000000051', '018f1000-0000-7000-8000-000000000041', 1,
          'Форма не открывается.', '018f1000-0000-7000-8000-000000000011', '2026-01-01T00:00:00Z'),
         ('018f1000-0000-7000-8000-000000000052', '018f1000-0000-7000-8000-000000000041', 2,
          'Форма открывается.', '018f1000-0000-7000-8000-000000000011', '2026-01-02T00:00:00Z'),
         ('018f1000-0000-7000-8000-000000000053', '018f1000-0000-7000-8000-000000000042', 1,
          'Первая одновременная редакция.', '018f1000-0000-7000-8000-000000000011', '2026-02-01T00:00:00Z'),
         ('018f1000-0000-7000-8000-000000000054', '018f1000-0000-7000-8000-000000000042', 2,
          'Вторая одновременная редакция.', '018f1000-0000-7000-8000-000000000011', '2026-02-01T00:00:00Z')`,
    );
    await pool.query(
      `INSERT INTO evidence (
         id, claim_id, context_id, relation, result, method, observation, limitations, source_kind,
         author_agent_id, author_owner_id, context_match, substantive, actor_independent,
         counts_as_reproduction, created_at
       ) VALUES
         (
           '018f1000-0000-7000-8000-000000000061', '018f1000-0000-7000-8000-000000000041',
           '018f1000-0000-7000-8000-000000000021', 'supports', 'failure',
           'Наблюдение до смены утверждения, записанное отдельно.',
           'Форма не открылась на первом контуре.', '',
           'organic', '018f1000-0000-7000-8000-000000000012', '018f1000-0000-7000-8000-000000000002',
           'compatible', true, true, true, '2026-01-01T00:01:00Z'
         ),
         (
           '018f1000-0000-7000-8000-000000000062', '018f1000-0000-7000-8000-000000000041',
           '018f1000-0000-7000-8000-000000000021', 'limits', 'success',
           'Наблюдение после смены утверждения, с другим ограничением.',
           'Проверено только в толстом клиенте.', 'Не переносилось на другие ОС.',
           'organic', '018f1000-0000-7000-8000-000000000011', '018f1000-0000-7000-8000-000000000001',
           'compatible', true, false, false, '2026-01-02T00:01:00Z'
         ),
         (
           '018f1000-0000-7000-8000-000000000063', '018f1000-0000-7000-8000-000000000042',
           '018f1000-0000-7000-8000-000000000021', 'supports', 'failure',
           'Наблюдение в ту же отметку времени, что и обе редакции.',
           'Нельзя выбрать, к какой редакции относится запись.', '',
           'organic', '018f1000-0000-7000-8000-000000000012', '018f1000-0000-7000-8000-000000000002',
           'compatible', true, true, true, '2026-02-01T00:00:00Z'
         )`,
    );
    const upgraded = await migrate(pool, source);
    expect(upgraded.applied).toEqual([
      '004_knowledge_publication.sql',
      '005_evidence_revision_attribution.sql',
      '006_environment_registry.sql',
      '007_registry_visibility.sql',
      '008_registry_snapshot_times.sql',
      '009_registry_publication_gate.sql',
      '010_telemetry_reports.sql',
      '011_handoff.sql',
    ]);
    const repeated = await migrate(pool, source);
    expect(repeated.applied).toEqual([]);
    expect(repeated.skipped).toContain('004_knowledge_publication.sql');
    const evidence = await pool.query<{ id: string; claim_revision: number; status_eligible: boolean }>(
      `SELECT id, claim_revision, status_eligible
       FROM evidence
       ORDER BY created_at ASC, id ASC`,
    );
    expect(evidence.rows).toEqual([
      { id: '018f1000-0000-7000-8000-000000000061', claim_revision: 1, status_eligible: true },
      { id: '018f1000-0000-7000-8000-000000000062', claim_revision: 2, status_eligible: true },
      { id: '018f1000-0000-7000-8000-000000000063', claim_revision: 2, status_eligible: false },
    ]);
    const statuses = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM claims ORDER BY id ASC`,
    );
    expect(statuses.rows).toEqual([
      { id: '018f1000-0000-7000-8000-000000000041', status: 'reported' },
      { id: '018f1000-0000-7000-8000-000000000042', status: 'reported' },
    ]);
  } finally {
    await rm(partial, { recursive: true, force: true });
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
