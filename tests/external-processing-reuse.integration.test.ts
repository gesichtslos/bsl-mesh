import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';

type Fixture = {
  title: string;
  body_md: string;
  topic: string;
  claim: string;
  context: Record<string, string>;
  author_evidence: Record<string, string>;
  same_owner_repeat: Record<string, string>;
  other_owner_support: Record<string, string>;
  incompatible_context: Record<string, string>;
  incompatible_evidence: Record<string, string>;
};

const fixture = JSON.parse(readFileSync(new URL('./fixtures/external-processing-enterprise.json', import.meta.url), 'utf8')) as Fixture;

type PublicCase = {
  id: string;
  body_md: string;
  source_kind: string;
  context: {
    application_mode: string;
    form_type: string;
    client_type: string;
  };
  claims: Array<{
    id: string;
    claim_text: string;
    status: string;
    classification: string;
    warnings: string[];
    evidence: Array<{
      limitations: string | null;
      context_match: string;
      counts_as_reproduction: boolean;
      actor_independent: boolean;
      source_kind: string;
    }>;
  }>;
};

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

function sqlClient(pool: Pool): SqlClient {
  return {
    query(sql, params) {
      if (params === undefined) {
        return pool.query(sql);
      }
      return pool.query(sql, [...params]);
    },
  };
}

function key(): string {
  return `epf-${randomBytes(8).toString('hex')}`;
}

async function sessionFor(app: FastifyInstance, email: string): Promise<string> {
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email, display_name: 'Synthetic Owner' },
  });
  expect(issued.statusCode).toBe(200);
  const magic = (issued.json() as { magic_link_token?: string }).magic_link_token;
  const consumed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link/consume',
    payload: { token: magic },
  });
  expect(consumed.statusCode).toBe(200);
  const token = (consumed.json() as { session_token?: string }).session_token;
  if (token === undefined) {
    throw new Error('Owner session was not issued.');
  }
  return token;
}

async function credentialFor(app: FastifyInstance, session: string, scopes: readonly string[]): Promise<string> {
  const agent = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload: { display_name: 'Synthetic Agent' },
  });
  expect(agent.statusCode).toBe(201);
  const agentId = (agent.json() as { id?: string }).id;
  const credential = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload: { agent_id: agentId, scopes, ttl_seconds: 3600 },
  });
  expect(credential.statusCode).toBe(201);
  const token = (credential.json() as { token?: string }).token;
  if (token === undefined) {
    throw new Error('Agent credential was not issued.');
  }
  return token;
}

function payload() {
  return {
    type: 'incident',
    title: fixture.title,
    body_md: fixture.body_md,
    topic: fixture.topic,
    context: fixture.context,
    claims: [{
      text: fixture.claim,
      evidence: [{ ...fixture.author_evidence, context: fixture.context }],
    }],
  };
}

function toolJson(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('Tool result did not include text.');
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error('Tool result did not include text.');
  }
  const text = content.map((item: unknown) => {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') {
      return item.text;
    }
    return undefined;
  }).find((item) => item !== undefined);
  if (text === undefined) {
    throw new Error('Tool result did not include text.');
  }
  if ('isError' in result && result.isError === true) {
    throw new Error(text);
  }
  return JSON.parse(text) as unknown;
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
  await resetDisposableSchema(sqlClient(pool), process.env);
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

test('a second agent can read the external-processing case without treating it as reproduced', async () => {
  const authorSession = await sessionFor(app, 'epf-author@example.test');
  const readerSession = await sessionFor(app, 'epf-reader@example.test');
  const author = await credentialFor(app, authorSession, ['cases:write', 'evidence:write', 'knowledge:read']);
  const reader = await credentialFor(app, readerSession, ['knowledge:read']);
  const supporter = await credentialFor(app, readerSession, ['evidence:write']);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/cases',
    headers: { authorization: `Bearer ${author}`, 'idempotency-key': key() },
    payload: payload(),
  });
  expect(created.statusCode).toBe(201);
  const caseId = (created.json() as { id: string }).id;
  const claimId = (created.json() as { claims: Array<{ id: string }> }).claims[0]?.id;
  if (claimId === undefined) {
    throw new Error('Claim was not created.');
  }
  const hidden = await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}` });
  expect(hidden.statusCode).toBe(404);
  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/cases/${caseId}/publication`,
    headers: { authorization: `Bearer ${author}`, 'idempotency-key': key() },
    payload: {},
  });
  expect(published.statusCode).toBe(200);
  const refusedPublication = await app.inject({
    method: 'POST',
    url: `/api/v1/cases/${caseId}/publication`,
    headers: { 'idempotency-key': key() },
    payload: {},
  });
  expect(refusedPublication.statusCode).toBe(401);
  const refusedEvidence = await app.inject({
    method: 'POST',
    url: `/api/v1/claims/${claimId}/evidence`,
    headers: { authorization: `Bearer ${reader}`, 'idempotency-key': key() },
    payload: { ...fixture.other_owner_support, context: fixture.context },
  });
  expect(refusedEvidence.statusCode).toBe(403);

  const search = await fetch(`${base}/api/v1/search?q=epf-enterprise-open`);
  expect(search.status).toBe(200);
  const found = await search.json() as { items: Array<{ id: string; classification: string; status: string }> };
  expect(found.items.some((item) => item.id === caseId)).toBe(true);
  expect(found.items.find((item) => item.id === caseId)?.classification).toBe('synthetic');
  expect(found.items.find((item) => item.id === caseId)?.status).toBe('reported');

  const anonymous = await fetch(`${base}/api/v1/cases/${caseId}`);
  expect(anonymous.status).toBe(200);
  const publicCase = await anonymous.json() as PublicCase;
  expect(publicCase.body_md).toContain('Платформа 1С в этом прогоне не запускалась');
  expect(publicCase.context.application_mode).toBe('ordinary');
  expect(publicCase.context.form_type).toBe('ordinary');
  expect(publicCase.context.client_type).toBe('thick');
  expect(publicCase.claims[0]?.claim_text).toBe(fixture.claim);
  expect(publicCase.claims[0]?.status).toBe('reported');
  expect(publicCase.claims[0]?.classification).toBe('synthetic');
  expect(publicCase.claims[0]?.evidence[0]?.limitations).toContain('Управляемые формы не покрыты');
  expect(publicCase.claims[0]?.evidence[0]?.counts_as_reproduction).toBe(false);
  expect(publicCase.source_kind).toBe('synthetic');
  expect(JSON.stringify(publicCase)).not.toContain('epf-author@example.test');

  const client = new Client(
    { name: 'epf-reader', version: '0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const listed = toolJson(await client.callTool({
      name: 'bslmesh_search_knowledge',
      arguments: { query: 'epf-enterprise-open' },
    })) as { items: Array<{ id: string }> };
    expect(listed.items.some((item) => item.id === caseId)).toBe(true);
    const viaMcp = toolJson(await client.callTool({
      name: 'bslmesh_get_case',
      arguments: { case_id: caseId },
    })) as PublicCase;
    expect(viaMcp.claims[0]?.status).toBe('reported');
    expect(viaMcp.claims[0]?.evidence[0]?.limitations).toContain('Только обычное приложение');
  } finally {
    await client.close();
  }

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/v1/claims/${claimId}/evidence`,
    headers: { authorization: `Bearer ${author}`, 'idempotency-key': key() },
    payload: { ...fixture.same_owner_repeat, context: fixture.context },
  });
  expect(repeated.statusCode).toBe(201);
  expect((repeated.json() as PublicCase).claims[0]?.status).toBe('reported');

  const secondOwner = await app.inject({
    method: 'POST',
    url: `/api/v1/claims/${claimId}/evidence`,
    headers: { authorization: `Bearer ${supporter}`, 'idempotency-key': key() },
    payload: { ...fixture.other_owner_support, context: fixture.context },
  });
  expect(secondOwner.statusCode).toBe(201);
  const stillSynthetic = secondOwner.json() as PublicCase;
  expect(stillSynthetic.claims[0]?.status).toBe('reported');
  expect(stillSynthetic.claims[0]?.classification).toBe('synthetic');
  expect(stillSynthetic.claims[0]?.evidence.every((item) => item.counts_as_reproduction === false)).toBe(true);

  const mismatched = await app.inject({
    method: 'POST',
    url: `/api/v1/claims/${claimId}/evidence`,
    headers: { authorization: `Bearer ${supporter}`, 'idempotency-key': key() },
    payload: {
      ...fixture.incompatible_evidence,
      context: { ...fixture.context, ...fixture.incompatible_context },
    },
  });
  expect(mismatched.statusCode).toBe(201);
  const warned = mismatched.json() as PublicCase;
  expect(warned.claims[0]?.status).not.toBe('reproduced');
  expect(warned.claims[0]?.warnings).toContain('Evidence context does not match the claim context.');
  expect(warned.claims[0]?.evidence.some((item) => item.context_match === 'mismatch')).toBe(true);
  const visibleWarning = await fetch(`${base}/api/v1/cases/${caseId}`);
  expect(visibleWarning.status).toBe(200);
  const warnedPublicly = await visibleWarning.json() as PublicCase;
  expect(warnedPublicly.claims[0]?.status).toBe('reported');
  expect(warnedPublicly.claims[0]?.warnings).toContain('Evidence context does not match the claim context.');
});

test('organic support from the same owner is not an independent reproduction', async () => {
  const organic = await buildApp(appConfig({ KNOWLEDGE_SOURCE_KIND: 'organic' }));
  try {
    const session = await sessionFor(organic, 'epf-organic@example.test');
    const other = await sessionFor(organic, 'epf-organic-other@example.test');
    const author = await credentialFor(organic, session, ['cases:write', 'evidence:write', 'knowledge:read']);
    const sameOwner = await credentialFor(organic, session, ['evidence:write']);
    const otherOwner = await credentialFor(organic, other, ['evidence:write']);
    const created = await organic.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: { authorization: `Bearer ${author}`, 'idempotency-key': key() },
      payload: {
        type: 'incident',
        title: fixture.title,
        body_md: fixture.body_md,
        topic: fixture.topic,
        context: fixture.context,
        claims: [{ text: fixture.claim }],
      },
    });
    expect(created.statusCode).toBe(201);
    const caseId = (created.json() as { id: string }).id;
    const claimId = (created.json() as { claims: Array<{ id: string }> }).claims[0]?.id;
    if (claimId === undefined) {
      throw new Error('Claim was not created.');
    }
    const release = await organic.inject({
      method: 'POST',
      url: `/api/v1/cases/${caseId}/publication`,
      headers: { authorization: `Bearer ${author}`, 'idempotency-key': key() },
      payload: {},
    });
    expect(release.statusCode).toBe(200);
    const supported = await organic.inject({
      method: 'POST',
      url: `/api/v1/claims/${claimId}/evidence`,
      headers: { authorization: `Bearer ${sameOwner}`, 'idempotency-key': key() },
      payload: { ...fixture.author_evidence, context: fixture.context },
    });
    expect(supported.statusCode).toBe(201);
    expect((supported.json() as PublicCase).claims[0]?.status).toBe('supported');
    const incompatible = await organic.inject({
      method: 'POST',
      url: `/api/v1/claims/${claimId}/evidence`,
      headers: { authorization: `Bearer ${otherOwner}`, 'idempotency-key': key() },
      payload: {
        ...fixture.incompatible_evidence,
        relation: 'supports',
        result: 'failure',
        context: { ...fixture.context, ...fixture.incompatible_context },
      },
    });
    expect(incompatible.statusCode).toBe(201);
    const claim = (incompatible.json() as PublicCase).claims[0];
    expect(claim?.status).toBe('supported');
    expect(claim?.status).not.toBe('reproduced');
    expect(claim?.warnings).toContain('Evidence context does not match the claim context.');
  } finally {
    await organic.close();
  }
});
