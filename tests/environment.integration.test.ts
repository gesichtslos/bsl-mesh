import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';
import { EnvironmentService } from '../src/environment/service.js';
import { IdentityService } from '../src/identity/service.js';

function appConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
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
    ...overrides,
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

async function toolText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (text === undefined) {
    throw new Error('Tool result did not include text.');
  }
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
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
  app = await buildApp(appConfig());
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

test('the public catalog is only the self-checked read profile and is not a BSL environment ranking', async () => {
  const catalog = await fetch(`${base}/agent/starter-catalog.json`);
  expect(catalog.status).toBe(200);
  const body = await catalog.json() as {
    catalog_version: string;
    content_sha256: string;
    historical_snapshots: boolean;
    signature: { signed: boolean };
    efficiency_ranking: null;
    bsl_environments: { independently_confirmed: boolean; published_bsl_development_environments: number; detail: string };
    profiles: Array<{ id: string; source_kind: string; status: string }>;
    tools: Array<{ id: string; upstream_url: string }>;
  };
  expect(catalog.headers.get('etag')).toBe(`"${body.content_sha256}"`);
  expect(body.catalog_version).toBe(body.content_sha256);
  expect(body.historical_snapshots).toBe(false);
  expect(body.signature.signed).toBe(false);
  expect(body.efficiency_ranking).toBeNull();
  expect(body.bsl_environments.independently_confirmed).toBe(false);
  expect(body.bsl_environments.published_bsl_development_environments).toBe(0);
  expect(body.bsl_environments.detail).toContain('No independently confirmed BSL development environment');
  expect(body.profiles.map((profile) => profile.id)).toEqual(['bsl-mesh-public-read']);
  expect(body.tools.map((tool) => tool.id)).toEqual(['bsl-mesh-mcp']);
  expect(body.tools[0]?.upstream_url).toBe('https://github.com/gesichtslos/bsl-mesh');
  const unchanged = await fetch(`${base}/agent/starter-catalog.json`, {
    headers: { 'if-none-match': catalog.headers.get('etag') ?? '' },
  });
  expect(unchanged.status).toBe(304);
  const hidden = await fetch(`${base}/api/v1/starter-profiles/bsl-ordinary-forms/versions/0.1.0`);
  const hiddenTool = await fetch(`${base}/api/v1/tool-versions/demo-untrusted-note/versions/0.1.0`);
  expect(hidden.status).toBe(404);
  expect(hiddenTool.status).toBe(404);
  expect(await fetch(`${base}/agent/quickstart.md`).then((response) => response.text())).toContain('наиболее эффективное окружение определить нельзя');
});

test('anonymous REST and MCP hide non-public versions and keep withdrawn history', async () => {
  await pool.query(
    `INSERT INTO environment_profiles (id, created_at) VALUES ('visibility-fixture', '2026-10-20T00:00:00Z')`,
  );
  await pool.query(
    `INSERT INTO profile_versions (
       profile_id, version, status, source_kind, summary, tasks, hosts, applicability, incompatibilities,
       components, verification_steps, rollback_steps, source_uris, limitations, alternatives,
       evidence_quality, recommendation_level, conflicts_of_interest, independent_owner_confirmations,
       last_reviewed_at, review_due_at, created_at, presentation
     )
     SELECT 'visibility-fixture', seed.version, seed.status, 'organic', summary, tasks, hosts, applicability, incompatibilities,
            components, verification_steps, rollback_steps, source_uris, limitations, alternatives,
            evidence_quality, recommendation_level, conflicts_of_interest, independent_owner_confirmations,
            last_reviewed_at, review_due_at, created_at, 'catalog'
     FROM (VALUES
       ('0.1.0', 'draft'),
       ('0.2.0', 'reviewed'),
       ('0.3.0', 'published'),
       ('0.4.0', 'published'),
       ('0.5.0', 'published'),
       ('0.6.0', 'published')
     ) AS seed(version, status)
     CROSS JOIN profile_versions AS source
     WHERE source.profile_id = 'bsl-mesh-public-read' AND source.version = '0.1.0'`,
  );
  await pool.query(`UPDATE profile_versions SET status = 'security_hold' WHERE profile_id = 'visibility-fixture' AND version = '0.3.0'`);
  await pool.query(`UPDATE profile_versions SET status = 'superseded' WHERE profile_id = 'visibility-fixture' AND version = '0.4.0'`);
  await pool.query(`UPDATE profile_versions SET status = 'contested' WHERE profile_id = 'visibility-fixture' AND version = '0.5.0'`);
  await pool.query(`UPDATE profile_versions SET status = 'withdrawn' WHERE profile_id = 'visibility-fixture' AND version = '0.6.0'`);
  const client = new Client(
    { name: 'bslmesh-starter', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const hidden = ['0.1.0', '0.2.0', '0.3.0'];
    const visible = [
      ['0.4.0', 'superseded'],
      ['0.5.0', 'contested'],
      ['0.6.0', 'withdrawn'],
    ] as const;
    for (const version of hidden) {
      const response = await fetch(`${base}/api/v1/starter-profiles/visibility-fixture/versions/${version}`);
      expect(response.status).toBe(404);
      await expect(toolText(client, 'bslmesh_get_starter_profile', {
        profile_id: 'visibility-fixture',
        version,
      })).rejects.toThrow();
    }
    for (const [version, status] of visible) {
      const response = await fetch(`${base}/api/v1/starter-profiles/visibility-fixture/versions/${version}`);
      expect(response.status).toBe(200);
      const rest = await response.json() as { status: string };
      expect(rest.status).toBe(status);
      const mcp = JSON.parse(await toolText(client, 'bslmesh_get_starter_profile', {
        profile_id: 'visibility-fixture',
        version,
      })) as { status: string };
      expect(mcp).toMatchObject(rest);
    }
    const listed = JSON.parse(await toolText(client, 'bslmesh_list_starter_profiles', {})) as {
      items: Array<{ id: string; version: string }>;
    };
    const withHistory = JSON.parse(await toolText(client, 'bslmesh_list_starter_profiles', {
      include_withdrawn: true,
    })) as { items: Array<{ id: string; version: string }> };
    const restCurrent = await fetch(`${base}/api/v1/starter-profiles`);
    const restHistory = await fetch(`${base}/api/v1/starter-profiles?include_withdrawn=true`);
    const restCurrentBody = await restCurrent.json() as { items: Array<{ id: string; version: string }> };
    const restHistoryBody = await restHistory.json() as { items: Array<{ id: string; version: string }> };
    const withdrawn = (items: Array<{ id: string; version: string }>) => (
      items.some((item) => item.id === 'visibility-fixture' && item.version === '0.6.0')
    );
    expect(listed.items.some((item) => item.id === 'visibility-fixture' && item.version === '0.1.0')).toBe(false);
    expect(withdrawn(listed.items)).toBe(false);
    expect(withdrawn(restCurrentBody.items)).toBe(false);
    expect(withdrawn(withHistory.items)).toBe(true);
    expect(withdrawn(restHistoryBody.items)).toBe(true);
  } finally {
    await client.close();
  }
});

test('published registry rows cannot be edited, deleted, or given a substituted upstream', async () => {
  const original = await fetch(`${base}/api/v1/tool-versions/bsl-mesh-mcp/versions/0.1.0`);
  const originalBody = await original.json() as { upstream_url: string; summary: string };
  await expect(pool.query(
    `UPDATE component_versions SET status = 'draft' WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/not allowed/);
  await expect(pool.query(
    `UPDATE component_versions SET summary = 'changed' WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  await expect(pool.query(
    `UPDATE environment_components SET upstream_url = 'https://github.com/gesichtslos/bsl-mesh/security' WHERE id = 'bsl-mesh-mcp'`,
  )).rejects.toThrow(/new version/);
  await expect(pool.query(
    `DELETE FROM component_versions WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/cannot be deleted/);
  await expect(pool.query(
    `DELETE FROM environment_components WHERE id = 'bsl-mesh-mcp'`,
  )).rejects.toThrow(/cannot be deleted/);
  const still = await fetch(`${base}/api/v1/tool-versions/bsl-mesh-mcp/versions/0.1.0`);
  expect(await still.json()).toMatchObject(originalBody);
  const service = new EnvironmentService(pool, new IdentityService(pool, appConfig(), () => new Date()), appConfig(), () => new Date());
  await expect(service.addComponentVersion({
    id: 'evil-local',
    kind: 'mcp',
    name: 'Evil',
    purpose: 'Must not be stored.',
    maintainer: 'fixture',
    upstreamUrl: 'https://127.0.0.1/mcp',
    license: 'none',
    version: '0.1.0',
    status: 'published',
    sourceKind: 'organic',
    summary: 'Rejected local upstream.',
  })).rejects.toThrow(/not an allowed public https address/);
  const absent = await pool.query(`SELECT id FROM environment_components WHERE id = 'evil-local'`);
  expect(absent.rows).toEqual([]);
  await service.addComponentVersion({
    id: 'bsl-mesh-mcp',
    kind: 'mcp',
    name: 'BSL Mesh MCP',
    purpose: 'A later version with the same public repository.',
    maintainer: 'gesichtslos/bsl-mesh',
    upstreamUrl: 'https://github.com/gesichtslos/bsl-mesh',
    license: 'License is not selected by the project owner.',
    version: '0.2.0',
    status: 'published',
    sourceKind: 'organic',
    summary: 'Second published version.',
  });
  const first = await fetch(`${base}/api/v1/tool-versions/bsl-mesh-mcp/versions/0.1.0`);
  const second = await fetch(`${base}/api/v1/tool-versions/bsl-mesh-mcp/versions/0.2.0`);
  expect(await first.json()).toMatchObject({ upstream_url: originalBody.upstream_url, summary: originalBody.summary });
  expect(await second.json()).toMatchObject({ summary: 'Second published version.' });
});

test('withdrawing a published profile changes the current catalog id and does not serve the old snapshot', async () => {
  const before = await fetch(`${base}/agent/starter-catalog.json`);
  const previous = await before.json() as { catalog_version: string; content_sha256: string };
  await pool.query(
    `UPDATE profile_versions SET status = 'withdrawn' WHERE profile_id = 'visibility-fixture' AND version = '0.5.0'`,
  );
  const after = await fetch(`${base}/agent/starter-catalog.json`);
  const next = await after.json() as { catalog_version: string; content_sha256: string; profiles: Array<{ id: string; version: string; status: string }> };
  expect(after.headers.get('etag')).toBe(`"${next.content_sha256}"`);
  expect(next.catalog_version).toBe(next.content_sha256);
  expect(next.catalog_version).not.toBe(previous.catalog_version);
  expect(next.profiles.some((profile) => profile.id === 'visibility-fixture' && profile.version === '0.5.0' && profile.status === 'withdrawn')).toBe(true);
  const client = new Client(
    { name: 'bslmesh-starter', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const current = JSON.parse(await toolText(client, 'bslmesh_get_catalog_snapshot', {
      catalog_version: next.catalog_version,
    })) as { catalog_version: string };
    expect(current.catalog_version).toBe(next.catalog_version);
    await expect(toolText(client, 'bslmesh_get_catalog_snapshot', {
      catalog_version: previous.catalog_version,
    })).rejects.toThrow(/Historical catalog snapshots are not retained/);
  } finally {
    await client.close();
  }
});

test('demonstration records stay out of the public catalog unless that mode is enabled', async () => {
  const service = new EnvironmentService(pool, new IdentityService(pool, appConfig(), () => new Date()), appConfig(), () => new Date());
  await service.addComponentVersion({
    id: 'demo-public-marker',
    kind: 'cli',
    name: 'Demonstration marker',
    purpose: 'Shown only in demonstration mode.',
    maintainer: 'fixture',
    upstreamUrl: 'https://github.com/gesichtslos/bsl-mesh',
    license: 'none',
    version: '0.1.0',
    status: 'published',
    sourceKind: 'organic',
    summary: 'Demonstration fixture.',
    presentation: 'demonstration',
  });
  const hidden = await fetch(`${base}/api/v1/tool-versions/demo-public-marker/versions/0.1.0`);
  expect(hidden.status).toBe(404);
  const demonstrated = await buildApp(appConfig({ REGISTRY_DEMONSTRATION: 'enabled' }));
  await demonstrated.listen({ host: '127.0.0.1', port: 0 });
  try {
    const address = demonstrated.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The demonstration listener did not bind.');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tool-versions/demo-public-marker/versions/0.1.0`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ demonstration: true, id: 'demo-public-marker' });
  } finally {
    await demonstrated.close();
  }
});

test('published timestamps cannot be rewritten or change the catalog digest', async () => {
  const before = await fetch(`${base}/agent/starter-catalog.json`);
  const digest = (await before.json() as { catalog_version: string }).catalog_version;
  await expect(pool.query(
    `UPDATE profile_versions SET created_at = '2026-11-01T00:00:00Z' WHERE profile_id = 'bsl-mesh-public-read' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  await expect(pool.query(
    `UPDATE profile_versions SET last_reviewed_at = '2026-11-01T00:00:00Z' WHERE profile_id = 'bsl-mesh-public-read' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  await expect(pool.query(
    `UPDATE profile_versions SET review_due_at = '2026-11-01T00:00:00Z' WHERE profile_id = 'bsl-mesh-public-read' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  await expect(pool.query(
    `UPDATE component_versions SET created_at = '2026-11-01T00:00:00Z' WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  await expect(pool.query(
    `UPDATE component_versions SET last_reviewed_at = '2026-11-01T00:00:00Z' WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
  )).rejects.toThrow(/immutable/);
  const after = await fetch(`${base}/agent/starter-catalog.json`);
  expect((await after.json() as { catalog_version: string }).catalog_version).toBe(digest);
});

test('a synthetic record cannot be inserted directly into a public status', async () => {
  await pool.query(
    `INSERT INTO environment_profiles (id, created_at) VALUES ('synthetic-bypass', '2026-10-20T00:00:00Z')`,
  );
  await pool.query(
    `INSERT INTO environment_components (id, kind, name, purpose, maintainer, upstream_url, license, created_at)
     VALUES ('synthetic-bypass', 'rule', 'Bypass', 'Synthetic bypass attempt.', 'fixture', 'https://github.com/gesichtslos/bsl-mesh', 'none', '2026-10-20T00:00:00Z')`,
  );
  for (const [index, status] of ['published', 'contested', 'withdrawn', 'superseded'].entries()) {
    await expect(pool.query(
      `INSERT INTO profile_versions (
         profile_id, version, status, source_kind, summary, tasks, hosts, applicability, incompatibilities,
         components, verification_steps, rollback_steps, source_uris, limitations, alternatives,
         evidence_quality, recommendation_level, conflicts_of_interest, independent_owner_confirmations,
         created_at, presentation
       )
       SELECT 'synthetic-bypass', $1, $2, 'synthetic', summary, tasks, hosts, applicability, incompatibilities,
              components, verification_steps, rollback_steps, source_uris, limitations, alternatives,
              evidence_quality, recommendation_level, conflicts_of_interest, 0, created_at, 'catalog'
       FROM profile_versions WHERE profile_id = 'bsl-mesh-public-read' AND version = '0.1.0'`,
      [`0.1.${index}`, status],
    )).rejects.toThrow(/cannot be public|must start from publication/);
    await expect(pool.query(
      `INSERT INTO component_versions (
         component_id, version, status, source_kind, summary, hosts, requirements, limitations, risks, provenance,
         evidence_quality, independent_owner_confirmations, created_at, kind, name, purpose, maintainer, upstream_url, license, presentation
       )
       SELECT 'synthetic-bypass', $1, $2, 'synthetic', summary, hosts, requirements, limitations, risks, provenance,
              evidence_quality, 0, created_at, kind, name, purpose, maintainer, upstream_url, license, 'catalog'
       FROM component_versions WHERE component_id = 'bsl-mesh-mcp' AND version = '0.1.0'`,
      [`0.2.${index}`, status],
    )).rejects.toThrow(/cannot be public|must start from publication/);
  }
  const catalog = await fetch(`${base}/agent/starter-catalog.json`);
  const body = await catalog.json() as { profiles: Array<{ id: string }>; tools: Array<{ id: string }> };
  expect(body.profiles.some((profile) => profile.id === 'synthetic-bypass')).toBe(false);
  expect(body.tools.some((tool) => tool.id === 'synthetic-bypass')).toBe(false);
});
