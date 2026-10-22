import { Client } from 'pg';

export const PRODUCTION_DATABASE = 'bslmesh_dev';
export const PRODUCTION_MIGRATOR = 'bslmesh_migrator';
export const PRIVILEGE_CHECK_DATABASE = 'bslmesh_privilege_check';
export const PRIVILEGE_CHECK_MIGRATOR = 'bslmesh_privilege_migrator';

const APPLICATION_ROLE = 'bslmesh_app';

export function assertPrivilegeTarget(database: string, migratorRole: string, nodeEnv: string): void {
  const production = database === PRODUCTION_DATABASE && migratorRole === PRODUCTION_MIGRATOR;
  const disposable = nodeEnv === 'test'
    && database === PRIVILEGE_CHECK_DATABASE
    && migratorRole === PRIVILEGE_CHECK_MIGRATOR;
  if (!production && !disposable) {
    throw new Error('Production privileges can only be applied to the existing application database.');
  }
}

export async function applyProductionPrivileges(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const host = required(env, 'PGHOST');
  const port = portFrom(env['PGPORT']);
  const database = required(env, 'PGDATABASE');
  const adminUser = required(env, 'PGUSER');
  const adminPassword = required(env, 'PGPASSWORD');
  const migratePassword = required(env, 'MIGRATE_PASSWORD');
  const migratorRole = env['MIGRATE_ROLE']?.trim() || PRODUCTION_MIGRATOR;
  const nodeEnv = env['NODE_ENV']?.trim() ?? '';
  assertPrivilegeTarget(database, migratorRole, nodeEnv);
  if (adminUser !== 'bslmesh_admin') {
    throw new Error('Production privileges must be applied by the database administrator role.');
  }
  const client = new Client({
    host,
    port,
    database,
    user: adminUser,
    password: adminPassword,
  });
  await client.connect();
  try {
    await runOne(
      client,
      'role',
      `SELECT format(
         '%s %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
         CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name)
           THEN 'ALTER ROLE' ELSE 'CREATE ROLE' END,
         $1::name,
         $2::text
       ) AS statement`,
      [migratorRole, migratePassword],
    );
    await runOne(
      client,
      'membership',
      `SELECT format('GRANT %I TO bslmesh_admin', $1::name) AS statement`,
      [migratorRole],
    );
    await runAll(
      client,
      'tables',
      `SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, $1::name) AS statement
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public'
         AND r.rolname = $2::name
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      [migratorRole, APPLICATION_ROLE],
    );
    await runAll(
      client,
      'sequences',
      `SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, $1::name) AS statement
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public'
         AND r.rolname = $2::name
         AND c.relkind = 'S'`,
      [migratorRole, APPLICATION_ROLE],
    );
    await runAll(
      client,
      'functions',
      `SELECT format('ALTER FUNCTION %s OWNER TO %I', p.oid::regprocedure, $1::name) AS statement
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
       WHERE n.nspname = 'public' AND r.rolname = $2::name`,
      [migratorRole, APPLICATION_ROLE],
    );
    await runAll(
      client,
      'types',
      `SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, $1::name) AS statement
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_roles r ON r.oid = t.typowner
       WHERE n.nspname = 'public'
         AND r.rolname = $2::name
         AND t.typtype = 'e'`,
      [migratorRole, APPLICATION_ROLE],
    );
    await runOne(
      client,
      'database-owner',
      `SELECT format('ALTER DATABASE %I OWNER TO %I', $1::name, $2::name) AS statement`,
      [database, migratorRole],
    );
    await runOne(
      client,
      'schema-owner',
      `SELECT format('ALTER SCHEMA public OWNER TO %I', $1::name) AS statement`,
      [migratorRole],
    );
    await runOne(
      client,
      'revoke-create',
      `SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', $1::name, $2::name) AS statement`,
      [database, APPLICATION_ROLE],
    );
    await client.query('REVOKE ALL ON SCHEMA public FROM bslmesh_app');
    await runOne(
      client,
      'connect',
      `SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', $1::name, $2::name) AS statement`,
      [database, APPLICATION_ROLE],
    );
    await client.query('GRANT USAGE ON SCHEMA public TO bslmesh_app');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bslmesh_app');
    await runAll(
      client,
      'migration-table',
      `SELECT 'REVOKE ALL ON TABLE schema_migrations FROM bslmesh_app' AS statement
       WHERE EXISTS (
         SELECT 1 FROM pg_tables
         WHERE schemaname = 'public' AND tablename = 'schema_migrations'
       )`,
      [],
    );
    await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bslmesh_app');
    await runOne(
      client,
      'default-tables',
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
         $1::name,
         $2::name
       ) AS statement`,
      [migratorRole, APPLICATION_ROLE],
    );
    await runOne(
      client,
      'default-sequences',
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
         $1::name,
         $2::name
       ) AS statement`,
      [migratorRole, APPLICATION_ROLE],
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Production privilege update failed')) {
      throw error;
    }
    throw publicPrivilegeError(error);
  } finally {
    await client.end();
  }
}

async function runOne(client: Client, step: string, sql: string, params: readonly unknown[]): Promise<void> {
  try {
    const formatted = await client.query<{ statement: string }>(sql, [...params]);
    const statement = formatted.rows[0]?.statement;
    if (statement === undefined || statement.trim() === '' || formatted.rows.length !== 1) {
      throw new Error('Production privilege update failed.');
    }
    await client.query(statement);
  } catch (error) {
    throw labelPrivilegeError(step, error);
  }
}

async function runAll(client: Client, step: string, sql: string, params: readonly unknown[]): Promise<void> {
  try {
    const formatted = await client.query<{ statement: string }>(sql, [...params]);
    for (const row of formatted.rows) {
      if (row.statement.trim() !== '') {
        await client.query(row.statement);
      }
    }
  } catch (error) {
    throw labelPrivilegeError(step, error);
  }
}

function labelPrivilegeError(step: string, error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('Production privilege update failed')) {
    return error;
  }
  const labeled = publicPrivilegeError(error);
  return new Error(`${labeled.message} [${step}]`);
}

function publicPrivilegeError(error: unknown): Error {
  const record = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const redacted = message.replace(/PASSWORD\s+'[^']*'/gi, 'PASSWORD [redacted]');
  if (redacted !== message || /password|secret|token/i.test(redacted)) {
    return new Error(`Production privilege update failed (${code}).`);
  }
  const brief = redacted.split('\n')[0] ?? '';
  if (brief !== '' && brief.length < 240) {
    return new Error(`Production privilege update failed (${code}): ${brief}`);
  }
  return new Error(`Production privilege update failed (${code}).`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function portFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 5432;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('PGPORT must be an integer from 1 to 65535.');
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error('PGPORT must be an integer from 1 to 65535.');
  }
  return port;
}

if (process.argv[1]?.endsWith('production-privileges.js') === true) {
  applyProductionPrivileges().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Production privilege update failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
