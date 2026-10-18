import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';
import { hashToken } from '../src/identity/tokens.js';

type SecretResponse = {
  magic_link_token?: string;
  session_token?: string;
  token?: string;
  id?: string;
  owner_id?: string;
  agent_id?: string;
  secret_available?: boolean;
  detail?: string;
  items?: Array<Record<string, unknown>>;
};

function identityConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
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
  return `synthetic-${randomBytes(8).toString('hex')}`;
}

function absent(value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain('node:internal');
}

async function issueSession(
  app: FastifyInstance,
  email: string,
  displayName: string,
): Promise<{ session: string; ownerId: string; magic: string }> {
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link',
    payload: { email, display_name: displayName },
  });
  expect(issued.statusCode).toBe(200);
  const magic = (issued.json() as SecretResponse).magic_link_token;
  if (magic === undefined) {
    throw new Error('Test adapter did not reveal a magic link once.');
  }
  const consumed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link/consume',
    payload: { token: magic },
  });
  expect(consumed.statusCode).toBe(200);
  const body = consumed.json() as SecretResponse;
  if (body.session_token === undefined || body.owner_id === undefined) {
    throw new Error('Owner session was not issued.');
  }
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/magic-link/consume',
    payload: { token: magic },
  });
  expect(replay.statusCode).toBe(401);
  absent(replay.json(), [magic, body.session_token]);
  return { session: body.session_token, ownerId: body.owner_id, magic };
}

async function registerAgent(app: FastifyInstance, session: string, displayName: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload: { display_name: displayName, description: 'Synthetic local agent' },
  });
  expect(response.statusCode).toBe(201);
  const id = (response.json() as SecretResponse).id;
  if (id === undefined) {
    throw new Error('Agent was not registered.');
  }
  return id;
}

async function issueCredential(
  app: FastifyInstance,
  session: string,
  agentId: string,
  scopes?: readonly string[],
  ttlSeconds = 3600,
): Promise<{ id: string; token: string }> {
  const payload: { agent_id: string; ttl_seconds: number; scopes?: string[] } = {
    agent_id: agentId,
    ttl_seconds: ttlSeconds,
  };
  if (scopes !== undefined) {
    payload.scopes = [...scopes];
  }
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as SecretResponse;
  if (body.id === undefined || body.token === undefined || body.secret_available !== true) {
    throw new Error('Credential secret was not revealed once.');
  }
  return { id: body.id, token: body.token };
}

async function storedText(pool: Pool): Promise<string> {
  const result = await pool.query<{ blob: string | null }>(
    `SELECT string_agg(blob, '') AS blob FROM (
       SELECT token_hash AS blob FROM credentials
       UNION ALL SELECT token_hash FROM owner_sessions
       UNION ALL SELECT token_hash FROM magic_links
       UNION ALL SELECT detail::text FROM audit_events
       UNION ALL SELECT response_json::text FROM idempotency_records
       UNION ALL SELECT email FROM owners
       UNION ALL SELECT display_name FROM agents
     ) AS rows`,
  );
  return result.rows[0]?.blob ?? '';
}

let app: FastifyInstance;
let pool: Pool;

beforeAll(async () => {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  pool = createPool(databaseUrl);
  await resetDisposableSchema(sqlClient(pool), process.env);
  await migrate(pool);
  app = await buildApp(identityConfig());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('write scope, ownership, revocation, expiry, audit, and secrets', async () => {
  const ownerA = await issueSession(app, 'owner-a@example.test', 'Synthetic Owner A');
  const ownerB = await issueSession(app, 'owner-b@example.test', 'Synthetic Owner B');
  const agentA = await registerAgent(app, ownerA.session, 'Synthetic Agent A');
  const agentB = await registerAgent(app, ownerB.session, 'Synthetic Agent B');
  const repeatKey = key();
  const firstAgent = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': repeatKey },
    payload: { display_name: 'Synthetic Agent Repeat' },
  });
  const secondAgent = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': repeatKey },
    payload: { display_name: 'Synthetic Agent Repeat' },
  });
  expect(firstAgent.statusCode).toBe(201);
  expect(secondAgent.json()).toEqual(firstAgent.json());
  const mismatch = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': repeatKey },
    payload: { display_name: 'Different Name' },
  });
  expect(mismatch.statusCode).toBe(409);

  const readOnly = await issueCredential(app, ownerA.session, agentA);
  const writer = await issueCredential(app, ownerA.session, agentA, ['profile:read', 'cases:write']);
  const evidenceOnly = await issueCredential(app, ownerB.session, agentB, ['profile:read', 'evidence:write']);
  const credentialKey = key();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': credentialKey },
    payload: { agent_id: agentA, scopes: ['cases:write'], ttl_seconds: 3600 },
  });
  const createdAgain = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': credentialKey },
    payload: { agent_id: agentA, scopes: ['cases:write'], ttl_seconds: 3600 },
  });
  const createdBody = created.json() as SecretResponse;
  const createdAgainBody = createdAgain.json() as SecretResponse;
  expect(created.statusCode).toBe(201);
  expect(createdAgain.statusCode).toBe(201);
  expect(createdAgainBody.id).toBe(createdBody.id);
  expect(createdAgainBody.secret_available).toBe(false);
  expect(createdAgainBody.token).toBeUndefined();
  absent(createdAgainBody, [createdBody.token ?? '', writer.token, readOnly.token]);

  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${readOnly.token}`, 'idempotency-key': key() },
    payload: { scope: 'cases:write' },
  });
  expect(denied.statusCode).toBe(403);
  expect(denied.headers['content-type']).toContain('application/problem+json');
  expect(denied.json()).toMatchObject({ detail: 'The credential does not include the required scope.' });
  absent(denied.json(), [readOnly.token, writer.token]);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: { scope: 'cases:write' },
  });
  expect(allowed.statusCode).toBe(204);
  const independent = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: { scope: 'evidence:write' },
  });
  expect(independent.statusCode).toBe(403);

  const impersonated = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: { scope: 'cases:write', agent_id: agentB },
  });
  const randomAgent = '018f1a00-0000-7000-8000-000000000099';
  const impersonatedMissing = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': key() },
    payload: { scope: 'cases:write', agent_id: randomAgent },
  });
  expect(impersonated.statusCode).toBe(403);
  expect(impersonatedMissing.statusCode).toBe(403);
  expect(impersonated.json()).toMatchObject({ detail: 'The credential cannot act as the requested agent.' });
  expect((impersonated.json() as SecretResponse).detail).toBe((impersonatedMissing.json() as SecretResponse).detail);
  absent(impersonated.json(), [writer.token, 'Synthetic Owner B', 'Synthetic Agent B', ownerB.session]);

  const foreignAgent = await app.inject({
    method: 'GET',
    url: `/api/v1/owners/me/agents/${agentB}`,
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  const missingAgent = await app.inject({
    method: 'GET',
    url: `/api/v1/owners/me/agents/${randomAgent}`,
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  expect(foreignAgent.statusCode).toBe(404);
  expect(missingAgent.statusCode).toBe(404);
  expect((foreignAgent.json() as SecretResponse).detail).toBe((missingAgent.json() as SecretResponse).detail);
  absent(foreignAgent.json(), ['Synthetic Agent B', 'owner-b@example.test', writer.token]);

  const ownAgents = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  const ownIds = ((ownAgents.json() as SecretResponse).items ?? []).map((item) => item['id']);
  expect(ownIds).toContain(agentA);
  expect(ownIds).not.toContain(agentB);

  const otherOwner = await app.inject({
    method: 'GET',
    url: `/api/v1/owners/${ownerB.ownerId}`,
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  expect(otherOwner.statusCode).toBe(404);
  absent(otherOwner.json(), ['owner-b@example.test', ownerB.session]);

  const crossCredential = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': key() },
    payload: { agent_id: agentB, scopes: ['cases:write'], ttl_seconds: 3600 },
  });
  expect(crossCredential.statusCode).toBe(404);
  absent(crossCredential.json(), ['Synthetic Agent B', writer.token]);

  const agentOnOwnerRoute = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/audit',
    headers: { authorization: `Bearer ${writer.token}` },
  });
  expect(agentOnOwnerRoute.statusCode).toBe(401);
  const ownerOnAgentRoute = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  expect(ownerOnAgentRoute.statusCode).toBe(401);

  const profile = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${writer.token}` },
  });
  expect(profile.statusCode).toBe(200);
  expect(profile.json()).toMatchObject({ agent_id: agentA, owner_id: ownerA.ownerId, publication_enabled: true });
  absent(profile.json(), [writer.token, readOnly.token]);

  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/v1/owners/me/credentials/${readOnly.id}`,
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': key() },
  });
  expect(revoked.statusCode).toBe(200);
  const afterRevoke = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${readOnly.token}` },
  });
  expect(afterRevoke.statusCode).toBe(401);
  absent(afterRevoke.json(), [readOnly.token]);

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  expect((listed.json() as SecretResponse).items?.some((item) => item['id'] === writer.id)).toBe(true);
  absent(listed.json(), [writer.token, readOnly.token, createdBody.token ?? '', ownerA.session, ownerA.magic]);

  const rotated = await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credentials/${writer.id}/rotate`,
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': key() },
    payload: { ttl_seconds: 3600 },
  });
  expect(rotated.statusCode).toBe(201);
  const rotatedBody = rotated.json() as SecretResponse;
  expect(rotatedBody.token).toBeTypeOf('string');
  expect(rotatedBody.token).not.toBe(writer.token);
  const oldWriter = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${writer.token}` },
  });
  expect(oldWriter.statusCode).toBe(401);
  const newWriter = rotatedBody.token ?? '';
  const rotatedProfile = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${newWriter}` },
  });
  expect(rotatedProfile.statusCode).toBe(200);

  const disable = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/publication',
    headers: { authorization: `Bearer ${ownerA.session}`, 'idempotency-key': key() },
    payload: { enabled: false },
  });
  expect(disable.statusCode).toBe(200);
  const secondWriter = await issueCredential(app, ownerA.session, agentA, ['meetups:write']);
  const blockedCases = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${newWriter}`, 'idempotency-key': key() },
    payload: { scope: 'cases:write' },
  });
  const blockedMeetups = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${secondWriter.token}`, 'idempotency-key': key() },
    payload: { scope: 'meetups:write' },
  });
  expect(blockedCases.json()).toMatchObject({ status: 403, detail: 'The owner has disabled publication.' });
  expect(blockedMeetups.statusCode).toBe(403);
  const stillReads = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${newWriter}` },
  });
  expect(stillReads.statusCode).toBe(200);
  expect(stillReads.json()).toMatchObject({ publication_enabled: false });
  const otherStillWrites = await app.inject({
    method: 'POST',
    url: '/api/v1/access/write',
    headers: { authorization: `Bearer ${evidenceOnly.token}`, 'idempotency-key': key() },
    payload: { scope: 'evidence:write' },
  });
  expect(otherStillWrites.statusCode).toBe(204);

  const auditA = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/audit',
    headers: { authorization: `Bearer ${ownerA.session}` },
  });
  const auditB = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/audit',
    headers: { authorization: `Bearer ${ownerB.session}` },
  });
  const auditAText = JSON.stringify(auditA.json());
  const auditBText = JSON.stringify(auditB.json());
  const auditItemsA = (auditA.json() as SecretResponse).items ?? [];
  expect(auditAText).toContain(agentA);
  expect(auditAText).toContain('credential.revoked');
  expect(auditAText).toContain('"reason":"impersonation"');
  for (const item of auditItemsA) {
    const recordedAgent = item['agent_id'];
    if (typeof recordedAgent === 'string') {
      expect(ownIds).toContain(recordedAgent);
    }
  }
  expect(auditBText).toContain(agentB);
  expect(auditBText).not.toContain(agentA);
  expect(auditBText).not.toContain('impersonation');
  absent(auditA.json(), [writer.token, newWriter, readOnly.token, ownerA.session, ownerA.magic, secondWriter.token]);
  absent(auditB.json(), [evidenceOnly.token, ownerB.session, ownerB.magic]);

  const database = await storedText(pool);
  for (const secret of [writer.token, newWriter, readOnly.token, ownerA.session, ownerA.magic, ownerB.session, evidenceOnly.token, secondWriter.token]) {
    expect(database).not.toContain(secret);
  }
  const hash = await pool.query<{ token_hash: string }>(
    'SELECT token_hash FROM credentials WHERE id = $1',
    [rotatedBody.id],
  );
  expect(hash.rows[0]?.token_hash).toBe(hashToken(newWriter));

  await pool.query(`UPDATE owners SET status = 'disabled' WHERE id = $1`, [ownerB.ownerId]);
  const disabledOwner = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${evidenceOnly.token}` },
  });
  expect(disabledOwner.statusCode).toBe(401);
  absent(disabledOwner.json(), [evidenceOnly.token]);
});

test('an expired credential is rejected', async () => {
  let current = new Date('2026-10-18T00:00:00.000Z');
  const clock = await buildApp(identityConfig(), { now: () => current });
  try {
    const owner = await issueSession(clock, 'owner-expired@example.test', 'Synthetic Owner Expired');
    const agentId = await registerAgent(clock, owner.session, 'Synthetic Agent Expired');
    const credential = await issueCredential(clock, owner.session, agentId, ['profile:read'], 3600);
    const fresh = await clock.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(fresh.statusCode).toBe(200);
    current = new Date('2026-10-18T02:00:00.000Z');
    const expired = await clock.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(expired.statusCode).toBe(401);
    absent(expired.json(), [credential.token, owner.session, owner.magic]);
  } finally {
    await clock.close();
  }
});

test('rate limits apply independently to an agent and an owner', async () => {
  const owner = await issueSession(app, 'owner-rate@example.test', 'Synthetic Owner Rate');
  const agentA = await registerAgent(app, owner.session, 'Synthetic Agent Rate A');
  const agentB = await registerAgent(app, owner.session, 'Synthetic Agent Rate B');
  const credentialA = await issueCredential(app, owner.session, agentA, ['profile:read']);
  const credentialB = await issueCredential(app, owner.session, agentB, ['profile:read']);
  await pool.query('DELETE FROM rate_limit_buckets');

  const agentLimited = await buildApp(identityConfig({
    RATE_LIMIT_AGENT_PER_MINUTE: '2',
    RATE_LIMIT_OWNER_PER_MINUTE: '10',
  }));
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await agentLimited.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: `Bearer ${credentialA.token}` },
      });
      statuses.push(response.statusCode);
      absent(response.json(), [credentialA.token, owner.session]);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const third = await agentLimited.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credentialA.token}` },
    });
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toMatch(/^[0-9]+$/);
    const otherAgent = await agentLimited.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credentialB.token}` },
    });
    expect(otherAgent.statusCode).toBe(200);
  } finally {
    await agentLimited.close();
  }

  await pool.query('DELETE FROM rate_limit_buckets');
  const ownerLimited = await buildApp(identityConfig({
    RATE_LIMIT_AGENT_PER_MINUTE: '10',
    RATE_LIMIT_OWNER_PER_MINUTE: '2',
  }));
  try {
    const first = await ownerLimited.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credentialA.token}` },
    });
    const second = await ownerLimited.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credentialB.token}` },
    });
    const third = await ownerLimited.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: { authorization: `Bearer ${credentialA.token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toMatch(/^[0-9]+$/);
    absent(third.json(), [credentialA.token, credentialB.token, owner.session]);
  } finally {
    await ownerLimited.close();
  }
});

test('request logs and repeated magic links do not retain raw tokens', async () => {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logged = await buildApp(identityConfig({ LOG_LEVEL: 'info' }), { logStream });
  try {
    const owner = await issueSession(logged, 'owner-log@example.test', 'Synthetic Owner Log');
    const agentId = await registerAgent(logged, owner.session, 'Synthetic Agent Log');
    const credential = await issueCredential(logged, owner.session, agentId, ['profile:read', 'cases:write']);
    const output = lines.join('\n');
    expect(output).not.toContain(owner.magic);
    expect(output).not.toContain(owner.session);
    expect(output).not.toContain(credential.token);
    const database = await storedText(pool);
    expect(database).not.toContain(owner.magic);
    expect(database).not.toContain(owner.session);
    expect(database).not.toContain(credential.token);
  } finally {
    await logged.close();
  }

  const email = 'owner-flood@example.test';
  let limited = 0;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link',
      payload: { email, display_name: 'Synthetic Owner Flood' },
    });
    if (response.statusCode === 429) {
      limited += 1;
      absent(response.json(), ['bslm_ml_']);
    }
  }
  expect(limited).toBe(1);
});

test('a credential cannot claim an agent owned by someone else at the database boundary', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expect(client.query(
      `INSERT INTO credentials (id, owner_id, agent_id, token_hash, scopes, expires_at)
       SELECT '018f1a00-0000-7000-8000-0000000000aa',
              owners.id,
              agents.id,
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ARRAY['profile:read']::text[],
              now() + interval '1 hour'
       FROM owners
       JOIN agents ON agents.owner_id <> owners.id
       LIMIT 1`,
    )).rejects.toThrow(/foreign key|violates/i);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
