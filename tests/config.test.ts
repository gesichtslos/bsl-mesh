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
      authPublicRegistration: false,
      authTestAdapter: false,
      oidc: null,
      rateLimitAgentPerMinute: 60,
      rateLimitOwnerPerMinute: 120,
      rateLimitPublicPerMinute: 120,
      knowledgeSourceKind: 'synthetic',
      registryDemonstration: false,
      publicHostname: null,
      trustProxyHops: 0,
      handoffEnabled: false,
      toolReleaseDir: 'build/tool-release',
    });
    expect(loadConfig({ ...complete, HANDOFF_ENABLED: 'enabled' }).handoffEnabled).toBe(true);
    expect(() => loadConfig({ ...complete, HANDOFF_ENABLED: 'yes' })).toThrow('HANDOFF_ENABLED');
  });

  test('assigns synthetic knowledge outside production and organic knowledge in production', () => {
    expect(loadConfig({ ...complete, NODE_ENV: 'production' }).knowledgeSourceKind).toBe('organic');
    expect(loadConfig({ ...complete, KNOWLEDGE_SOURCE_KIND: 'import' }).knowledgeSourceKind).toBe('import');
    expect(() => loadConfig({ ...complete, KNOWLEDGE_SOURCE_KIND: 'client-supplied' })).toThrow(
      'KNOWLEDGE_SOURCE_KIND',
    );
  });

  test('keeps public registration closed and rejects the test adapter in production', () => {
    expect(() => loadConfig({ ...complete, AUTH_PUBLIC_REGISTRATION: 'true' })).toThrow(
      'reviewed identity provider',
    );
    expect(() => loadConfig({
      ...complete,
      NODE_ENV: 'production',
      AUTH_TEST_ADAPTER: 'enabled',
    })).toThrow('cannot be enabled when NODE_ENV is production');
    expect(loadConfig({ ...complete, AUTH_TEST_ADAPTER: 'enabled' }).authTestAdapter).toBe(true);
  });

  test('rejects a partial or credentialed OIDC issuer without echoing it', () => {
    expect(() => loadConfig({ ...complete, AUTH_OIDC_ISSUER: 'https://idp.example.test' })).toThrow(
      'must be set together',
    );
    const secret = 'synthetic-user-secret';
    expect(() => loadConfig({
      ...complete,
      AUTH_OIDC_ISSUER: `https://user:${secret}@idp.example.test/realm`,
      AUTH_OIDC_CLIENT_ID: 'synthetic-client',
    })).toThrow(ConfigError);
    try {
      loadConfig({
        ...complete,
        AUTH_OIDC_ISSUER: `https://user:${secret}@idp.example.test/realm`,
        AUTH_OIDC_CLIENT_ID: 'synthetic-client',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
    }
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
