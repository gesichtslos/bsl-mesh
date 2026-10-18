import { Client } from 'pg';

import { redactDatabaseUrl } from './redact.js';
import { assertTestDatabaseIdentity, readDatabaseTarget } from './test-database.js';
import { resolveDatabaseUrl } from './database-url.js';

export async function prepareTestDatabase(env: NodeJS.ProcessEnv): Promise<void> {
  const test = assertTestDatabaseIdentity(env);
  const application = readDatabaseTarget(resolveDatabaseUrl(env), 'DATABASE_URL');
  const adminUrl = requiredText(env, 'ADMIN_DATABASE_URL');
  const admin = new Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await admin.connect();
  try {
    const identity = await admin.query<{ is_superuser: boolean }>(
      `SELECT rolsuper AS is_superuser
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    if (identity.rows[0]?.is_superuser !== true) {
      throw new Error('Preparing the test database requires the administrative superuser.');
    }
    await ensureRole(admin, test.username, passwordOf(test.connectionString));
    await ensureDatabase(admin, test.databaseName, test.username, false);
    await ensureDatabase(admin, application.databaseName, application.username, true);
    await admin.query(`REVOKE ALL ON DATABASE ${quoteIdent(application.databaseName)} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(application.databaseName)} TO ${quoteIdent(application.username)}`,
    );
    await admin.query(`REVOKE ALL ON DATABASE ${quoteIdent(test.databaseName)} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${quoteIdent(test.databaseName)} TO ${quoteIdent(test.username)}`,
    );
    const owner = new Client({ connectionString: withDatabase(adminUrl, test.databaseName) });
    await owner.connect();
    try {
      await owner.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(test.username)}`);
      await owner.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(test.username)}`);
    } finally {
      await owner.end();
    }
  } finally {
    await admin.end();
  }
}

async function ensureRole(admin: Client, role: string, password: string): Promise<void> {
  const existing = await admin.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
  );
  const statement = existing.rows[0]?.exists === true ? 'ALTER ROLE' : 'CREATE ROLE';
  const sql = await admin.query<{ command: string }>(
    `SELECT format(
       '%s %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
       $1::text,
       $2::text,
       $3::text
     ) AS command`,
    [statement, role, password],
  );
  const command = sql.rows[0]?.command;
  if (command === undefined) {
    throw new Error('Could not build the test role statement.');
  }
  await admin.query(command);
}

async function ensureDatabase(
  admin: Client,
  databaseName: string,
  owner: string,
  preserveExistingOwner: boolean,
): Promise<void> {
  const existing = await admin.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [databaseName],
  );
  if (existing.rows[0]?.exists !== true) {
    await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)} OWNER ${quoteIdent(owner)}`);
    return;
  }
  if (!preserveExistingOwner) {
    await admin.query(`ALTER DATABASE ${quoteIdent(databaseName)} OWNER TO ${quoteIdent(owner)}`);
  }
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function passwordOf(connectionString: string): string {
  const password = decodeURIComponent(new URL(connectionString).password);
  if (password === '') {
    throw new Error('TEST_DATABASE_URL must include a password.');
  }
  return password;
}

function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.href;
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error('Refusing to interpolate an unexpected SQL identifier.');
  }
  return `"${identifier}"`;
}

export function publicPrepareError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not prepare the test database.';
  return redactDatabaseUrl(message);
}
