export type TestDatabaseCheck = 'mode' | 'database' | 'privileges';

export class TestDatabaseGuardError extends Error {
  readonly check: TestDatabaseCheck;

  constructor(check: TestDatabaseCheck, message: string) {
    super(message);
    this.name = 'TestDatabaseGuardError';
    this.check = check;
  }
}

export type DatabaseTarget = {
  connectionString: string;
  databaseName: string;
  username: string;
};

export type SqlClient = {
  query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
};

const TEST_DATABASE_NAME = /^[a-z][a-z0-9_]{0,40}_test$/;
const TEST_ROLE_NAME = /^[a-z][a-z0-9_]{0,40}_tester$/;

export function assertTestDatabaseIdentity(env: NodeJS.ProcessEnv): DatabaseTarget {
  const application = readRequiredTarget(env, 'DATABASE_URL');
  const test = readRequiredTarget(env, 'TEST_DATABASE_URL');
  if (!TEST_DATABASE_NAME.test(test.databaseName) || test.databaseName === application.databaseName) {
    throw new TestDatabaseGuardError(
      'database',
      'TEST_DATABASE_URL must name a *_test database different from DATABASE_URL.',
    );
  }
  if (!TEST_ROLE_NAME.test(test.username) || test.username === application.username) {
    throw new TestDatabaseGuardError(
      'privileges',
      'TEST_DATABASE_URL must use a dedicated *_tester role different from the application role.',
    );
  }
  return test;
}

export function assertStaticTestDatabase(env: NodeJS.ProcessEnv): DatabaseTarget {
  if (env['NODE_ENV'] !== 'test') {
    throw new TestDatabaseGuardError('mode', 'NODE_ENV must be test before the test database is used.');
  }
  return assertTestDatabaseIdentity(env);
}

export async function assertLiveTestDatabase(client: SqlClient, env: NodeJS.ProcessEnv): Promise<DatabaseTarget> {
  const target = assertStaticTestDatabase(env);
  const application = readRequiredTarget(env, 'DATABASE_URL');
  const identity = await client.query(
    `SELECT current_database() AS database_name,
            current_user AS username,
            r.rolsuper AS is_superuser,
            r.rolcreatedb AS can_create_database
     FROM pg_roles AS r
     WHERE r.rolname = current_user`,
  );
  const row = identity.rows[0];
  if (
    row?.['database_name'] !== target.databaseName
    || row['username'] !== target.username
  ) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The connected database or role does not match TEST_DATABASE_URL. Schema reset was not run.',
    );
  }
  if (row['is_superuser'] === true) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The test role is a superuser. Schema reset was not run.',
    );
  }
  if (row['can_create_database'] === true) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The test role can create databases. Schema reset was not run.',
    );
  }
  const createPrivilege = await client.query(
    `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`,
  );
  if (createPrivilege.rows[0]?.['can_create'] !== true) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The test role cannot create objects in the test database. Schema reset was not run.',
    );
  }
  const applicationAccess = await client.query(
    `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
            has_database_privilege(current_user, $1, 'CONNECT') AS can_connect,
            pg_catalog.pg_get_userbyid(datdba) AS owner
     FROM pg_database
     WHERE datname = $1`,
    [application.databaseName],
  );
  const access = applicationAccess.rows[0];
  if (access?.['database_exists'] !== true) {
    throw new TestDatabaseGuardError(
      'database',
      'The application database named by DATABASE_URL does not exist. Schema reset was not run.',
    );
  }
  if (access['can_connect'] === true) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The test role can connect to the application database. Schema reset was not run.',
    );
  }
  if (access['owner'] === target.username) {
    throw new TestDatabaseGuardError(
      'privileges',
      'The test role owns the application database. Schema reset was not run.',
    );
  }
  return target;
}

export async function resetDisposableSchema(client: SqlClient, env: NodeJS.ProcessEnv): Promise<void> {
  await assertLiveTestDatabase(client, env);
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
}

export function readDatabaseTarget(connectionString: string, label: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TestDatabaseGuardError('database', `${label} must be a postgres URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseGuardError('database', `${label} must be a postgres URL.`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const username = decodeURIComponent(url.username);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName) || !/^[a-z][a-z0-9_]{0,62}$/.test(username)) {
    throw new TestDatabaseGuardError('database', `${label} has an unsupported database name or role.`);
  }
  return { connectionString, databaseName, username };
}

function readRequiredTarget(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'TEST_DATABASE_URL'): DatabaseTarget {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new TestDatabaseGuardError('database', `${name} is required before the test database is used.`);
  }
  return readDatabaseTarget(value.trim(), name);
}
