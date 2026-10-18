import { Writable } from 'node:stream';

import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const SECRET = 'super-secret-token';
const DB_PASSWORD = 'super-secret-db-pass';

function testConfig(databaseUrl = `postgres://bslmesh_dev:${DB_PASSWORD}@127.0.0.1:1/bslmesh_dev`): AppConfig {
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '3000',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'info',
    NODE_ENV: 'test',
  });
}

describe('http foundation', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  test('live does not require the database', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('ready fails closed when the database is unreachable', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body: unknown = response.json();
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
    });
    expect(JSON.stringify(body)).not.toContain(DB_PASSWORD);
  });

  test('capabilities report only the implemented health feature', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      api_version: '0.1.0',
      mcp: 'unsupported',
      features: ['health', 'identity', 'knowledge'],
    });
  });

  test('unknown routes use problem+json', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/missing' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    });
  });

  test('invalid JSON uses problem+json and omits a stack', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json() as { detail: string; status: number };
    expect(body.status).toBe(400);
    expect(body.detail.toLowerCase()).not.toContain('stack');
    expect(JSON.stringify(body)).not.toContain(DB_PASSWORD);
  });

  test('authorization headers are redacted in request logs', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = await buildApp(testConfig(), { logStream });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.statusCode).toBe(200);
    app.log.info(
      {
        req: { headers: { authorization: `Bearer ${SECRET}`, cookie: 'session=secret' } },
        password: DB_PASSWORD,
      },
      'sensitive fields',
    );
    const logged = lines.join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(DB_PASSWORD);
    expect(logged).not.toContain('session=secret');
    expect(logged).toContain('[Redacted]');
  });
});
