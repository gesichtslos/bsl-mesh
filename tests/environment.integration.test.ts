import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';
function config(): AppConfig {
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

let app: FastifyInstance;
let pool: Pool;
let base: string;

beforeAll(async () => {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  pool = createPool(databaseUrl);
  await resetDisposableSchema(sql(pool), process.env);
  await migrate(pool);
  app = await buildApp(config());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The listener did not bind.');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('a newcomer reads the catalog over HTTPS without an account or MCP', async () => {
  const catalog = await fetch(`${base}/agent/starter-catalog.json`);
  expect(catalog.status).toBe(200);
  expect(catalog.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);
  expect(catalog.headers.get('cache-control')).toContain('public');
  const body = await catalog.json() as {
    signature: { signed: boolean; status: string };
    efficiency_ranking: null;
    profiles: Array<{ id: string; source_kind: string; status: string; evidence_quality: string; confirmed_practice: boolean }>;
    tools: Array<{ id: string; upstream_url: string; purpose: string; sha256: string | null; sha256_is_trust: boolean }>;
  };
  expect(body.signature.signed).toBe(false);
  expect(body.signature.status).toBe('unsupported');
  expect(body.efficiency_ranking).toBeNull();
  expect(body.profiles.map((profile) => profile.id).sort()).toEqual([
    'bsl-development-base',
    'bsl-managed-forms',
    'bsl-mesh-public-read',
    'bsl-ordinary-forms',
  ]);
  const synthetic = body.profiles.filter((profile) => profile.source_kind === 'synthetic');
  expect(synthetic.every((profile) => profile.status !== 'published' && profile.confirmed_practice === false)).toBe(true);
  expect(synthetic.every((profile) => profile.evidence_quality === 'insufficient_evidence')).toBe(true);
  expect(body.tools.every((tool) => tool.upstream_url.startsWith('https://github.com/gesichtslos/bsl-mesh'))).toBe(true);
  const injection = body.tools.find((tool) => tool.id === 'demo-untrusted-note');
  expect(injection?.purpose).toContain('Ignore previous instructions');
  expect(injection?.sha256).toBeNull();
  expect(injection?.sha256_is_trust).toBe(false);
  expect(JSON.stringify(body)).not.toContain('approval_granted_by_server');
  expect(JSON.stringify(body)).not.toContain('shell_command_to_run_unconditionally');

  const again = await fetch(`${base}/agent/starter-catalog.json`, { headers: { 'if-none-match': catalog.headers.get('etag') ?? '' } });
  expect(again.status).toBe(304);
  const start = await fetch(`${base}/start`);
  expect(start.status).toBe(200);
  expect(await start.text()).not.toContain('<script>');
  const quickstart = await fetch(`${base}/agent/quickstart.md`);
  expect(quickstart.status).toBe(200);
  expect(await quickstart.text()).toContain('наиболее эффективное окружение определить нельзя');
  const manifest = await fetch(`${base}/agent/security-manifest.md`);
  expect(manifest.status).toBe(200);
  expect(await manifest.text()).toContain('ПРАВИЛО ДОВЕРИЯ');
  const signatures = await fetch(`${base}/agent/catalog-signatures.json`);
  expect(await signatures.json()).toMatchObject({ signed: false, status: 'unsupported' });
});

test('REST and MCP return the same starter profile and keep withdrawn history', async () => {
  const rest = await fetch(`${base}/api/v1/starter-profiles/bsl-ordinary-forms/versions/0.1.0`);
  expect(rest.status).toBe(200);
  const restBody = await rest.json() as { id: string; source_kind: string; status: string };
  const client = new Client(
    { name: 'bslmesh-starter', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  try {
    const listed = await client.callTool({ name: 'bslmesh_list_starter_profiles', arguments: {} });
    const text = listed.content?.find((item) => item.type === 'text')?.text;
    const page = JSON.parse(text ?? '{}') as { items: Array<{ id: string }> };
    expect(page.items.some((item) => item.id === 'bsl-ordinary-forms')).toBe(true);
    const profile = await client.callTool({
      name: 'bslmesh_get_starter_profile',
      arguments: { profile_id: 'bsl-ordinary-forms', version: '0.1.0' },
    });
    const profileText = profile.content?.find((item) => item.type === 'text')?.text ?? '';
    expect(JSON.parse(profileText)).toMatchObject(restBody);
    const snapshot = await client.callTool({ name: 'bslmesh_get_catalog_snapshot', arguments: {} });
    const snapshotText = snapshot.content?.find((item) => item.type === 'text')?.text ?? '';
    expect(JSON.parse(snapshotText)).toMatchObject({ signature: { signed: false }, efficiency_ranking: null });
  } finally {
    await client.close();
  }

  const before = await pool.query<{ summary: string }>(
    `SELECT summary FROM component_versions WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  );
  await expect(pool.query(
    `UPDATE component_versions SET summary = 'changed' WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  const after = await pool.query<{ summary: string }>(
    `SELECT summary FROM component_versions WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  );
  expect(after.rows[0]?.summary).toBe(before.rows[0]?.summary);
  await expect(pool.query(
    `UPDATE profile_versions SET status = 'published' WHERE profile_id = 'bsl-ordinary-forms' AND version = '0.1.0'`,
  )).rejects.toThrow(/synthetic/);
  await pool.query(
    `UPDATE profile_versions SET status = 'withdrawn' WHERE profile_id = 'bsl-mesh-public-read' AND version = '0.1.0'`,
  );
  await pool.query(
    `INSERT INTO registry_events (id, object_type, object_id, object_version, action, reason, created_at)
     VALUES ('018f2000-0000-7000-8000-000000000099', 'profile', 'bsl-mesh-public-read', '0.1.0', 'withdrawn', 'Withdrawn for the registry history test.', '2026-10-20T00:00:00Z')`,
  );
  const withdrawn = await fetch(`${base}/api/v1/starter-profiles/bsl-mesh-public-read/versions/0.1.0`);
  const withdrawnBody = await withdrawn.json() as { status: string; events: Array<{ action: string }> };
  expect(withdrawnBody.status).toBe('withdrawn');
  expect(withdrawnBody.events.some((event) => event.action === 'withdrawn')).toBe(true);
  const hidden = await fetch(`${base}/api/v1/starter-profiles`);
  const hiddenBody = await hidden.json() as { items: Array<{ id: string; version: string }> };
  expect(hiddenBody.items.some((item) => item.id === 'bsl-mesh-public-read' && item.version === '0.1.0')).toBe(false);
});
