import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';
import { LocalTelemetry } from '../src/telemetry/store.js';

function appConfig(): AppConfig {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '3000',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    AUTH_PUBLIC_REGISTRATION: 'false',
    AUTH_TEST_ADAPTER: 'enabled',
  });
}

function sql(pool: Pool): SqlClient {
  return {
    query(text, params) {
      if (params === undefined) {
        return pool.query(text);
      }
      return pool.query(text, [...params]);
    },
  };
}

function key(): string {
  return `telemetry-${randomBytes(8).toString('hex')}`;
}

async function session(app: FastifyInstance, email: string): Promise<{ token: string; ownerId: string }> {
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email, display_name: 'Synthetic Owner' },
  });
  const magic = (issued.json() as { magic_link_token?: string }).magic_link_token;
  const consumed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link/consume',
    payload: { token: magic },
  });
  const body = consumed.json() as { session_token?: string; owner_id?: string };
  if (body.session_token === undefined || body.owner_id === undefined) {
    throw new Error('Owner session was not issued.');
  }
  return { token: body.session_token, ownerId: body.owner_id };
}

async function credential(app: FastifyInstance, sessionToken: string, scopes: string[]): Promise<{ id: string; token: string }> {
  const agent = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${sessionToken}`, 'idempotency-key': key() },
    payload: { display_name: 'Synthetic Agent', description: 'Telemetry fixture' },
  });
  const agentId = (agent.json() as { id?: string }).id;
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${sessionToken}`, 'idempotency-key': key() },
    payload: { agent_id: agentId, scopes, ttl_seconds: 3600 },
  });
  const body = issued.json() as { id?: string; token?: string };
  if (body.id === undefined || body.token === undefined) {
    throw new Error('Credential was not issued.');
  }
  return { id: body.id, token: body.token };
}

function report(sourceKind: 'organic' | 'synthetic'): Record<string, unknown> {
  const telemetry = new LocalTelemetry(mkdtempSync(path.join(tmpdir(), 'bslmesh-report-')), () => new Date('2026-10-20T00:00:00.000Z'), mkdtempSync(path.join(tmpdir(), 'bslmesh-root-')));
  telemetry.enable();
  const task = telemetry.startTask({
    family: 'synthetic-read',
    form: 'unknown',
    sourceKind,
    configurationFamily: null,
    mcpIds: [],
    cursorVersion: null,
    cliVersion: null,
  });
  telemetry.finishTask(task.id, 'unknown', null);
  return telemetry.preview(task.id);
}

let app: FastifyInstance;
let pool: Pool;
let logs: string[];

beforeAll(async () => {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  pool = createPool(databaseUrl);
  await resetDisposableSchema(sql(pool), process.env);
  await migrate(pool);
  logs = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  app = await buildApp(appConfig(), { logStream });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('private telemetry reports stay owner-scoped, idempotent, and unverified', async () => {
  const ownerA = await session(app, 'telemetry-a@example.test');
  const ownerB = await session(app, 'telemetry-b@example.test');
  await pool.query('UPDATE owners SET publication_enabled = false WHERE id = $1', [ownerA.ownerId]);
  const writer = await credential(app, ownerA.token, ['telemetry:write']);
  const casesOnly = await credential(app, ownerA.token, ['cases:write']);
  const readerB = await credential(app, ownerB.token, ['telemetry:write']);
  const synthetic = report('synthetic');
  const organic = report('organic');
  const secret = 'super-secret-token';
  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${casesOnly.token}`, 'idempotency-key': String(synthetic['report_id']) },
    payload: synthetic,
  });
  expect(denied.statusCode).toBe(403);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': String(synthetic['report_id']) },
    payload: synthetic,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    acceptance: 'stored_unverified',
    independent_owner_confirmations: 0,
  });
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': String(synthetic['report_id']) },
    payload: synthetic,
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(created.json());
  const stored = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM telemetry_reports WHERE owner_id = $1', [ownerA.ownerId]);
  expect(stored.rows[0]?.count).toBe(1);
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': String(synthetic['report_id']) },
    payload: { ...synthetic, source_kind: 'organic' },
  });
  expect(conflict.statusCode).toBe(409);
  const organicCreated = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': String(organic['report_id']) },
    payload: organic,
  });
  expect(organicCreated.statusCode).toBe(201);
  const rows = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM telemetry_reports WHERE owner_id = $1', [ownerA.ownerId]);
  expect(rows.rows[0]?.count).toBe(2);
  const filtered = await app.inject({
    method: 'GET',
    url: '/api/v1/telemetry/reports?source_kind=organic',
    headers: { authorization: `Bearer ${ownerA.token}` },
  });
  expect(filtered.statusCode).toBe(200);
  const filteredBody = filtered.json() as { items: Array<{ source_kind: string }> };
  expect(filteredBody.items.map((item) => item.source_kind)).toEqual(['organic']);
  const foreign = await app.inject({
    method: 'GET',
    url: `/api/v1/telemetry/reports/${String(synthetic['report_id'])}`,
    headers: { authorization: `Bearer ${readerB.token}` },
  });
  expect(foreign.statusCode).toBe(404);
  const extra = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: { ...organic, prompt: secret, report_id: '018f1000-0000-7000-8000-000000000099' },
  });
  expect(extra.statusCode).toBe(422);
  expect(logs.join('\n')).not.toContain(secret);
  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/v1/owners/me/credentials/${writer.id}`,
    headers: { authorization: `Bearer ${ownerA.token}`, 'idempotency-key': key() },
  });
  expect(revoked.statusCode, JSON.stringify(revoked.json())).toBe(200);
  const afterRevoke = await app.inject({
    method: 'POST',
    url: '/api/v1/telemetry/reports',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: organic,
  });
  expect(afterRevoke.statusCode).toBe(401);
  const catalog = await app.inject({ method: 'GET', url: '/agent/starter-catalog.json' });
  expect(catalog.statusCode).toBe(200);
  const audit = await pool.query<{ detail: string }>('SELECT detail::text AS detail FROM audit_events');
  expect(audit.rows.map((row) => row.detail).join('\n')).not.toContain(secret);
});
