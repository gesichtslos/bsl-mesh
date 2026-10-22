import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import { expect, test } from 'vitest';

import { buildDatabaseUrl, decodedDatabasePassword } from '../src/db/database-url.js';
import { migrate, migrationsDirectory } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  PRIVILEGE_CHECK_DATABASE,
  PRIVILEGE_CHECK_MIGRATOR,
  applyProductionPrivileges,
} from '../src/db/production-privileges.js';

test('an application-owned schema becomes migrator-owned and the application role keeps only data access', async () => {
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  const applicationUrl = process.env['DATABASE_URL'];
  if (adminUrl === undefined || applicationUrl === undefined) {
    throw new Error('ADMIN_DATABASE_URL and DATABASE_URL are required.');
  }
  const adminAddress = new URL(adminUrl);
  const host = adminAddress.hostname;
  const port = Number(adminAddress.port || '5432');
  const migratePassword = "privilege'quote";
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVILEGE_CHECK_DATABASE} WITH (FORCE)`);
    await admin.query(`REVOKE ${PRIVILEGE_CHECK_MIGRATOR} FROM bslmesh_admin`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${PRIVILEGE_CHECK_MIGRATOR}`);
    await admin.query(`CREATE DATABASE ${PRIVILEGE_CHECK_DATABASE} OWNER bslmesh_app`);
    await admin.query(`REVOKE ALL ON DATABASE ${PRIVILEGE_CHECK_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${PRIVILEGE_CHECK_DATABASE} TO bslmesh_app`);
  } finally {
    await admin.end();
  }

  const appUrl = buildDatabaseUrl({
    username: 'bslmesh_app',
    password: decodedDatabasePassword(applicationUrl),
    host,
    port,
    database: PRIVILEGE_CHECK_DATABASE,
  });
  const preparer = new Client({ connectionString: appUrl });
  await preparer.connect();
  try {
    await preparer.query('CREATE TABLE notes (id integer PRIMARY KEY, label text)');
    await preparer.query('INSERT INTO notes (id, label) VALUES (1, NULL)');
    await preparer.query('CREATE SEQUENCE note_ids');
  } finally {
    await preparer.end();
  }
  const appPool = createPool(appUrl);
  try {
    const first = await migrate(appPool);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.skipped).toEqual([]);
  } finally {
    await appPool.end();
  }

  const privilegeEnv = {
    PGHOST: host,
    PGPORT: String(port),
    PGDATABASE: PRIVILEGE_CHECK_DATABASE,
    PGUSER: 'bslmesh_admin',
    PGPASSWORD: decodeURIComponent(adminAddress.password),
    MIGRATE_PASSWORD: migratePassword,
    MIGRATE_ROLE: PRIVILEGE_CHECK_MIGRATOR,
    NODE_ENV: 'test',
  };
  const limited = new Client({ connectionString: appUrl });
  const migratorUrl = buildDatabaseUrl({
    username: PRIVILEGE_CHECK_MIGRATOR,
    password: migratePassword,
    host,
    port,
    database: PRIVILEGE_CHECK_DATABASE,
  });
  const migrator = new Client({ connectionString: migratorUrl });
  const scratch = await mkdtemp(path.join(tmpdir(), 'bslmesh-privilege-'));
  try {
    await applyProductionPrivileges(privilegeEnv);
    await applyProductionPrivileges(privilegeEnv);
    await limited.connect();
    await migrator.connect();

    await limited.query("UPDATE notes SET label = 'kept' WHERE id = 1");
    await limited.query('DELETE FROM notes WHERE id = 1');
    await limited.query('INSERT INTO notes (id, label) VALUES (1, NULL)');
    const readBack = await limited.query<{ label: string | null }>('SELECT label FROM notes WHERE id = 1');
    expect(readBack.rows).toEqual([{ label: null }]);
    const meta = await limited.query<{ service_name: string }>('SELECT service_name FROM app_meta');
    expect(meta.rows[0]?.service_name).toBe('bsl-mesh');
    await expect(limited.query('CREATE TABLE denied (id integer)')).rejects.toThrow(/permission denied/i);
    await expect(limited.query('ALTER TABLE notes ADD COLUMN extra integer')).rejects.toThrow(/must be owner|permission denied/i);
    await expect(limited.query('DROP TABLE notes')).rejects.toThrow(/must be owner|permission denied/i);
    await expect(limited.query('DROP FUNCTION registry_guard_insert()')).rejects.toThrow(/must be owner|permission denied/i);
    await expect(limited.query("INSERT INTO schema_migrations (filename, checksum) VALUES ('011', 'x')")).rejects.toThrow(/permission denied/i);
    await expect(limited.query(`SET ROLE ${PRIVILEGE_CHECK_MIGRATOR}`)).rejects.toThrow(/permission denied/i);
    const membership = await limited.query<{ member: boolean }>(
      'SELECT pg_has_role(current_user, $1::name, $2::text) AS member',
      [PRIVILEGE_CHECK_MIGRATOR, 'member'],
    );
    expect(membership.rows[0]?.member).toBe(false);

    const owners = await migrator.query<{ owner: string }>(
      `SELECT DISTINCT r.rolname AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')`,
    );
    expect(owners.rows).toEqual([{ owner: PRIVILEGE_CHECK_MIGRATOR }]);
    const functions = await migrator.query<{ owner: string; count: number }>(
      `SELECT r.rolname AS owner, count(*)::int AS count
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
       WHERE n.nspname = 'public'
       GROUP BY r.rolname`,
    );
    expect(functions.rows).toEqual([{ owner: PRIVILEGE_CHECK_MIGRATOR, count: expect.any(Number) }]);
    expect(functions.rows[0]?.count).toBeGreaterThan(0);
    const databaseOwner = await migrator.query<{ owner: string }>(
      `SELECT pg_get_userbyid(datdba) AS owner
       FROM pg_database
       WHERE datname = current_database()`,
    );
    expect(databaseOwner.rows[0]?.owner).toBe(PRIVILEGE_CHECK_MIGRATOR);

    const source = migrationsDirectory();
    for (const name of await readdir(source)) {
      await copyFile(path.join(source, name), path.join(scratch, name));
    }
    const migratorPool = createPool(migratorUrl);
    try {
      const repeated = await migrate(migratorPool, scratch);
      expect(repeated.applied).toEqual([]);
      expect(repeated.skipped.length).toBeGreaterThan(0);
      await writeFile(
        path.join(scratch, '011_privilege_check.sql'),
        'ALTER TABLE notes ADD COLUMN reviewed boolean NOT NULL DEFAULT false;\nCREATE TABLE future_change (id integer PRIMARY KEY);\n',
      );
      const upgraded = await migrate(migratorPool, scratch);
      expect(upgraded.applied).toEqual(['011_privilege_check.sql']);
      await limited.query('UPDATE notes SET reviewed = true WHERE id = 1');
      await limited.query('INSERT INTO future_change (id) VALUES (1)');
      await writeFile(
        path.join(scratch, '011_privilege_check.sql'),
        'ALTER TABLE notes ADD COLUMN tampered boolean;\n',
      );
      await expect(migrate(migratorPool, scratch)).rejects.toThrow(/changed after it was applied/);
      const columns = await migrator.query<{ name: string }>(
        `SELECT column_name AS name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'notes'
         ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.name)).toEqual(['id', 'label', 'reviewed']);
      await writeFile(
        path.join(scratch, '011_privilege_check.sql'),
        'ALTER TABLE notes ADD COLUMN reviewed boolean NOT NULL DEFAULT false;\nCREATE TABLE future_change (id integer PRIMARY KEY);\n',
      );
      await writeFile(
        path.join(scratch, '012_privilege_rollback.sql'),
        'CREATE TABLE rolled_back (id integer);\nSELECT 1/0;\n',
      );
      await expect(migrate(migratorPool, scratch)).rejects.toThrow(/division by zero/i);
      const rolledBack = await migrator.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_tables
           WHERE schemaname = 'public' AND tablename = 'rolled_back'
         ) AS exists`,
      );
      expect(rolledBack.rows[0]?.exists).toBe(false);
      const recorded = await migrator.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename',
      );
      expect(recorded.rows.some((row) => row.filename === '012_privilege_rollback.sql')).toBe(false);
      expect(recorded.rows.some((row) => row.filename === '011_privilege_check.sql')).toBe(true);
    } finally {
      await migratorPool.end();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await limited.end().catch(() => undefined);
    await migrator.end().catch(() => undefined);
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${PRIVILEGE_CHECK_DATABASE} WITH (FORCE)`);
      await cleanup.query(`REVOKE ${PRIVILEGE_CHECK_MIGRATOR} FROM bslmesh_admin`).catch(() => undefined);
      await cleanup.query(`DROP ROLE IF EXISTS ${PRIVILEGE_CHECK_MIGRATOR}`);
    } finally {
      await cleanup.end();
    }
  }
});
