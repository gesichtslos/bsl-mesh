import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';
import { buildDatabaseUrl, decodedDatabasePassword, resolveDatabaseUrl } from '../src/db/database-url.js';

const password = 'a@b:c/d#e%f g';

describe('database URL encoding', () => {
  test('keeps a password with reserved characters intact', () => {
    const connectionString = buildDatabaseUrl({
      username: 'bslmesh_app',
      password,
      host: 'db',
      port: 5432,
      database: 'bslmesh_dev',
    });
    const url = new URL(connectionString);
    expect(url.username).toBe('bslmesh_app');
    expect(url.hostname).toBe('db');
    expect(url.pathname).toBe('/bslmesh_dev');
    expect(decodedDatabasePassword(connectionString)).toBe(password);
    expect(connectionString.split('@')).toHaveLength(2);
  });

  test('prefers raw PG* parts over a broken DATABASE_URL', () => {
    const resolved = resolveDatabaseUrl({
      DATABASE_URL: 'postgres://bslmesh_app:a@b@db:5432/bslmesh_dev',
      PGUSER: 'bslmesh_app',
      PGPASSWORD: password,
      PGHOST: 'db',
      PGPORT: '5432',
      PGDATABASE: 'bslmesh_dev',
    });
    expect(decodedDatabasePassword(resolved)).toBe(password);
    expect(loadConfig({
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'info',
      NODE_ENV: 'test',
      PGUSER: 'bslmesh_app',
      PGPASSWORD: password,
      PGHOST: 'db',
      PGPORT: '5432',
      PGDATABASE: 'bslmesh_dev',
    }).databaseUrl).toBe(resolved);
  });
});
