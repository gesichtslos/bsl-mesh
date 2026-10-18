import { Client } from 'pg';

import { buildDatabaseUrl } from './database-url.js';
import { redactDatabaseUrl } from './redact.js';

export const APPLICATION_ROLE = 'bslmesh_app';
export const ADMIN_ROLE = 'bslmesh_admin';
export const APPLICATION_DATABASE = 'bslmesh_dev';

export async function ensureApplicationRole(env: NodeJS.ProcessEnv): Promise<void> {
  const appPassword = required(env, 'APP_PASSWORD');
  const adminPassword = required(env, 'POSTGRES_PASSWORD');
  const admin = await connectAdmin(env);
  try {
    const identity = await admin.query<{ is_superuser: boolean }>(
      'SELECT rolsuper AS is_superuser FROM pg_roles WHERE rolname = current_user',
    );
    if (identity.rows[0]?.is_superuser !== true) {
      throw new Error('Ensuring database roles requires the administrative superuser.');
    }
    await ensureLoginRole(admin, ADMIN_ROLE, adminPassword, true);
    await ensureLoginRole(admin, APPLICATION_ROLE, appPassword, false);
    await ensureOwnedDatabase(admin, APPLICATION_DATABASE, APPLICATION_ROLE);
    await grantApplicationAccess(admin);
  } finally {
    await admin.end();
  }
}

export function publicRoleError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not ensure database roles.';
  return redactDatabaseUrl(message);
}

async function connectAdmin(env: NodeJS.ProcessEnv): Promise<Client> {
  const candidates = adminCandidates(env);
  let lastError: unknown;
  for (const connectionString of candidates) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(redactDatabaseUrl(lastError instanceof Error ? lastError.message : 'Could not connect as an administrative role.'));
}

function adminCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env['ADMIN_DATABASE_URL']?.trim();
  const password = env['POSTGRES_PASSWORD'];
  const host = env['PGHOST']?.trim() || '127.0.0.1';
  const port = Number(env['PGPORT']?.trim() || '5432');
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  }
  if (password !== undefined && password !== '') {
    for (const username of [ADMIN_ROLE, 'bslmesh_dev']) {
      candidates.push(buildDatabaseUrl({
        username,
        password,
        host,
        port,
        database: 'postgres',
      }));
    }
  }
  return [...new Set(candidates)];
}

async function ensureLoginRole(admin: Client, role: string, password: string, superuser: boolean): Promise<void> {
  const existing = await admin.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
  );
  const statement = existing.rows[0]?.exists === true ? 'ALTER ROLE' : 'CREATE ROLE';
  const privilege = superuser ? 'SUPERUSER CREATEDB CREATEROLE' : 'NOSUPERUSER NOCREATEDB NOCREATEROLE';
  const formatted = await admin.query<{ command: string }>(
    `SELECT format('%s %I LOGIN ${privilege} PASSWORD %L', $1::text, $2::text, $3::text) AS command`,
    [statement, role, password],
  );
  const command = formatted.rows[0]?.command;
  if (command === undefined) {
    throw new Error(`Could not build the statement for role ${role}.`);
  }
  await admin.query(command);
}

async function ensureOwnedDatabase(admin: Client, databaseName: string, owner: string): Promise<void> {
  const existing = await admin.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [databaseName],
  );
  if (existing.rows[0]?.exists === true) {
    await admin.query(`ALTER DATABASE ${quoteIdent(databaseName)} OWNER TO ${quoteIdent(owner)}`);
    return;
  }
  await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)} OWNER ${quoteIdent(owner)}`);
}

async function grantApplicationAccess(admin: Client): Promise<void> {
  await admin.query(`REVOKE ALL ON DATABASE ${quoteIdent(APPLICATION_DATABASE)} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${quoteIdent(APPLICATION_DATABASE)} TO ${quoteIdent(APPLICATION_ROLE)}`,
  );
  const application = new Client({ connectionString: adminConnectionForDatabase(admin, APPLICATION_DATABASE) });
  await application.connect();
  try {
    await application.query(`ALTER SCHEMA public OWNER TO ${quoteIdent(APPLICATION_ROLE)}`);
    await application.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(APPLICATION_ROLE)}`);
    const relations = await application.query<{ relname: string; relkind: string }>(`
      SELECT pg_class.relname, pg_class.relkind
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = 'public'
        AND pg_class.relkind IN ('r', 'p', 'v', 'm', 'S')
    `);
    for (const relation of relations.rows) {
      const statement = relation.relkind === 'S' ? 'ALTER SEQUENCE' : 'ALTER TABLE';
      const formatted = await application.query<{ command: string }>(
        `SELECT format('%s public.%I OWNER TO %I', $1::text, $2::text, $3::text) AS command`,
        [statement, relation.relname, APPLICATION_ROLE],
      );
      const command = formatted.rows[0]?.command;
      if (command === undefined) {
        throw new Error('Could not build an ownership statement.');
      }
      await application.query(command);
    }
  } finally {
    await application.end();
  }
}

function adminConnectionForDatabase(admin: Client, database: string): string {
  const host = admin.host;
  const port = admin.port;
  const user = admin.user;
  const password = admin.password;
  if (typeof host !== 'string' || typeof port !== 'number' || typeof user !== 'string' || typeof password !== 'string') {
    throw new Error('The administrative connection does not expose enough parameters to open the application database.');
  }
  return buildDatabaseUrl({
    username: user,
    password,
    host,
    port,
    database,
  });
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error('Refusing to interpolate an unexpected SQL identifier.');
  }
  return `"${identifier}"`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}
