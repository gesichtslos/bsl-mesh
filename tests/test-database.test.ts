import { expect, test } from 'vitest';

import {
  assertStaticTestDatabase,
  resetDisposableSchema,
  TestDatabaseGuardError,
  type SqlClient,
} from '../src/db/test-database.js';

const applicationUrl = 'postgres://bslmesh_dev:application-secret@127.0.0.1:5432/bslmesh_dev';
const testUrl = 'postgres://bslmesh_tester:test-secret@127.0.0.1:5432/bslmesh_test';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: applicationUrl,
    TEST_DATABASE_URL: testUrl,
    ...overrides,
  };
}

function forbiddenSql(): SqlClient {
  return {
    query() {
      throw new Error('SQL must not run');
    },
  };
}

test('accepts a dedicated test database and role', () => {
  expect(assertStaticTestDatabase(env())).toMatchObject({
    databaseName: 'bslmesh_test',
    username: 'bslmesh_tester',
  });
});

test('rejects a non-test mode before SQL', async () => {
  await expect(resetDisposableSchema(forbiddenSql(), env({ NODE_ENV: 'production' }))).rejects.toMatchObject({
    check: 'mode',
  });
});

test('rejects the application database before SQL', async () => {
  try {
    await resetDisposableSchema(forbiddenSql(), env({
      TEST_DATABASE_URL: applicationUrl,
    }));
    throw new Error('guard returned');
  } catch (error) {
    expect(error).toBeInstanceOf(TestDatabaseGuardError);
    expect(error instanceof Error ? error.message : '').not.toContain('application-secret');
    expect(error instanceof Error ? error.message : '').not.toContain('test-secret');
  }
  await expect(resetDisposableSchema(forbiddenSql(), env({
    TEST_DATABASE_URL: 'postgres://bslmesh_tester:test-secret@127.0.0.1:5432/bslmesh_dev',
  }))).rejects.toMatchObject({ check: 'database' });
});

test('rejects a test database that reuses the application name', async () => {
  await expect(resetDisposableSchema(forbiddenSql(), env({
    DATABASE_URL: 'postgres://bslmesh_dev:application-secret@127.0.0.1:5432/bslmesh_test',
    TEST_DATABASE_URL: testUrl,
  }))).rejects.toMatchObject({ check: 'database' });
});

test('rejects the application role before SQL', async () => {
  await expect(resetDisposableSchema(forbiddenSql(), env({
    TEST_DATABASE_URL: 'postgres://bslmesh_dev:application-secret@127.0.0.1:5432/bslmesh_test',
  }))).rejects.toMatchObject({ check: 'privileges' });
  await expect(resetDisposableSchema(forbiddenSql(), env({
    TEST_DATABASE_URL: 'postgres://postgres:test-secret@127.0.0.1:5432/bslmesh_test',
  }))).rejects.toMatchObject({ check: 'privileges' });
});

test('does not reset the schema when the live role is a superuser', async () => {
  const calls: string[] = [];
  const client: SqlClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT current_database')) {
        return {
          rows: [{
            database_name: 'bslmesh_test',
            username: 'bslmesh_tester',
            is_superuser: true,
            can_create_database: false,
          }],
        };
      }
      return { rows: [{ can_create: true, database_exists: true, can_connect: false, owner: 'bslmesh_dev' }] };
    },
  };
  await expect(resetDisposableSchema(client, env())).rejects.toMatchObject({ check: 'privileges' });
  expect(calls.some((sql) => sql.includes('DROP SCHEMA'))).toBe(false);
});

test('does not reset the schema when the role can connect to the application database', async () => {
  const calls: string[] = [];
  const client: SqlClient = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT current_database')) {
        return {
          rows: [{
            database_name: 'bslmesh_test',
            username: 'bslmesh_tester',
            is_superuser: false,
            can_create_database: false,
          }],
        };
      }
      if (sql.startsWith('SELECT has_database_privilege')) {
        return { rows: [{ can_create: true }] };
      }
      return { rows: [{ database_exists: true, can_connect: true, owner: 'bslmesh_dev' }] };
    },
  };
  await expect(resetDisposableSchema(client, env())).rejects.toThrow(/application database/);
  expect(calls.some((sql) => sql.includes('DROP SCHEMA'))).toBe(false);
});
