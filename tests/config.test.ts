import { describe, expect, test } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const complete = {
  HOST: '127.0.0.1',
  PORT: '3000',
  DATABASE_URL: 'postgres://bslmesh_dev:local@127.0.0.1:5432/bslmesh_dev',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
};

describe('loadConfig', () => {
  test('reads a complete environment', () => {
    expect(loadConfig(complete)).toEqual({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: complete.DATABASE_URL,
      logLevel: 'info',
      nodeEnv: 'test',
    });
  });

  test('rejects a missing database URL without echoing other values', () => {
    expect(() => loadConfig({
      HOST: complete.HOST,
      PORT: complete.PORT,
      LOG_LEVEL: complete.LOG_LEVEL,
      NODE_ENV: complete.NODE_ENV,
    })).toThrow(ConfigError);
    expect(() => loadConfig({
      HOST: complete.HOST,
      PORT: complete.PORT,
      LOG_LEVEL: complete.LOG_LEVEL,
      NODE_ENV: complete.NODE_ENV,
    })).toThrow('DATABASE_URL or PGUSER, PGPASSWORD, PGHOST, and PGDATABASE are required.');
  });

  test('rejects a non-postgres URL without returning the value', () => {
    expect(() => loadConfig({ ...complete, DATABASE_URL: 'http://example.invalid/db' })).toThrow(
      'DATABASE_URL must be a postgres URL.',
    );
  });

  test('rejects an empty host and an out-of-range port', () => {
    expect(() => loadConfig({ ...complete, HOST: '   ' })).toThrow('HOST is required.');
    expect(() => loadConfig({ ...complete, PORT: '70000' })).toThrow(
      'PORT must be an integer from 1 to 65535.',
    );
  });
});
