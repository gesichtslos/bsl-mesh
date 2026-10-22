import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  PRIVILEGE_CHECK_DATABASE,
  PRIVILEGE_CHECK_MIGRATOR,
  PRODUCTION_DATABASE,
  PRODUCTION_MIGRATOR,
  applyProductionPrivileges,
  assertPrivilegeTarget,
} from '../src/db/production-privileges.js';

const DB_PASSWORD = 'super-secret-db-pass';

function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '3000',
    DATABASE_URL: `postgres://bslmesh_dev:${DB_PASSWORD}@127.0.0.1:1/bslmesh_dev`,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...overrides,
  });
}

function initialize(protocolVersion: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'synthetic', version: '0' },
    },
  };
}

describe('production access', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  test('accepts the public hostname and both confirmed MCP versions', async () => {
    const app = await buildApp(testConfig({
      NODE_ENV: 'production',
      PUBLIC_HOSTNAME: 'bslmesh.ru',
      TRUST_PROXY_HOPS: '1',
    }));
    apps.push(app);
    const headers = {
      host: 'bslmesh.ru',
      origin: 'https://bslmesh.ru',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const live = await app.inject({ method: 'GET', url: '/health/live', headers });
    const capabilities = await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers });
    expect(live.statusCode).toBe(200);
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      mcp: { protocol: '2026-07-28', legacy_protocol: '2025-11-25', endpoint: '/mcp' },
    });
    for (const version of ['2026-07-28', '2025-11-25']) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: initialize(version),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"protocolVersion":"2025-11-25"');
    }
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      headers,
      payload: { email: 'person@example.test' },
    });
    expect(registration.statusCode).toBe(404);
  });

  test('rejects another host or origin when the public name is configured', async () => {
    const app = await buildApp(testConfig({ PUBLIC_HOSTNAME: 'bslmesh.ru' }));
    apps.push(app);
    const host = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: initialize('2025-11-25'),
    });
    const origin = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'bslmesh.ru',
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: initialize('2025-11-25'),
    });
    expect(host.statusCode).toBe(403);
    expect(origin.statusCode).toBe(403);
  });

  test('keeps the public hostname closed until it is configured', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'bslmesh.ru',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: initialize('2025-11-25'),
    });
    expect(response.statusCode).toBe(403);
  });

  test('trusts one proxy hop and ignores a client-supplied address before it', async () => {
    const forwarded = await buildApp(testConfig({ TRUST_PROXY_HOPS: '1' }));
    const direct = await buildApp(testConfig());
    apps.push(forwarded, direct);
    const seen: string[] = [];
    forwarded.addHook('onRequest', async (request) => {
      seen.push(request.ip);
    });
    const directSeen: string[] = [];
    direct.addHook('onRequest', async (request) => {
      directSeen.push(request.ip);
    });
    const headers = { 'x-forwarded-for': '198.51.100.20, 203.0.113.10' };
    await forwarded.inject({ method: 'GET', url: '/health/live', remoteAddress: '10.0.0.8', headers });
    await direct.inject({ method: 'GET', url: '/health/live', remoteAddress: '10.0.0.8', headers });
    expect(seen).toEqual(['203.0.113.10']);
    expect(directSeen).toEqual(['10.0.0.8']);
  });

  test('rejects a privilege target other than the existing application database', () => {
    expect(() => assertPrivilegeTarget(PRODUCTION_DATABASE, PRODUCTION_MIGRATOR, 'production')).not.toThrow();
    expect(() => assertPrivilegeTarget(
      PRIVILEGE_CHECK_DATABASE,
      PRIVILEGE_CHECK_MIGRATOR,
      'test',
    )).not.toThrow();
    expect(() => assertPrivilegeTarget('postgres', PRODUCTION_MIGRATOR, 'production')).toThrow(
      'existing application database',
    );
    expect(() => assertPrivilegeTarget(PRODUCTION_DATABASE, PRIVILEGE_CHECK_MIGRATOR, 'production')).toThrow(
      'existing application database',
    );
    expect(() => assertPrivilegeTarget(
      'bslmesh_dev; DROP DATABASE bslmesh_dev',
      PRODUCTION_MIGRATOR,
      'production',
    )).toThrow('existing application database');
  });

  test('rejects an unexpected role name before opening a database connection', async () => {
    await expect(applyProductionPrivileges({
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGDATABASE: PRODUCTION_DATABASE,
      PGUSER: 'bslmesh_admin',
      PGPASSWORD: 'not-used',
      MIGRATE_PASSWORD: "quote'; DROP ROLE bslmesh_app; --",
      MIGRATE_ROLE: "bslmesh_migrator'; DROP ROLE bslmesh_app; --",
      NODE_ENV: 'production',
    })).rejects.toThrow('existing application database');
  });
});

describe('production config', () => {
  test('rejects a URL or an excessive proxy hop count', () => {
    const complete = {
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_URL: `postgres://bslmesh_dev:${DB_PASSWORD}@127.0.0.1:5432/bslmesh_dev`,
      LOG_LEVEL: 'info',
      NODE_ENV: 'test',
    };
    expect(() => loadConfig({ ...complete, PUBLIC_HOSTNAME: 'https://bslmesh.ru' })).toThrow('PUBLIC_HOSTNAME');
    expect(() => loadConfig({ ...complete, TRUST_PROXY_HOPS: '9' })).toThrow('TRUST_PROXY_HOPS');
    expect(loadConfig({ ...complete, PUBLIC_HOSTNAME: 'bslmesh.ru', TRUST_PROXY_HOPS: '1' })).toMatchObject({
      publicHostname: 'bslmesh.ru',
      trustProxyHops: 1,
    });
  });
});
