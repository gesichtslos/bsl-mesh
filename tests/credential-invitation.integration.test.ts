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

function identityConfig(): AppConfig {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '3000',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'info',
    NODE_ENV: 'test',
    AUTH_PUBLIC_REGISTRATION: 'false',
    AUTH_TEST_ADAPTER: 'enabled',
    HANDOFF_ENABLED: 'enabled',
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
  return `invite-${randomBytes(8).toString('hex')}`;
}

function binding(): { value: string; hash: string; fingerprint: string } {
  const value = randomBytes(32).toString('base64url');
  const hash = hashToken(value);
  return { value, hash, fingerprint: hash.slice(0, 8) };
}

async function session(app: FastifyInstance, email: string): Promise<string> {
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
  const token = (consumed.json() as { session_token?: string }).session_token;
  if (token === undefined) {
    throw new Error('Owner session was not issued.');
  }
  return token;
}

async function agent(app: FastifyInstance, owner: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: { display_name: name },
  });
  const id = (response.json() as { id?: string }).id;
  if (id === undefined) {
    throw new Error('Agent was not registered.');
  }
  return id;
}

async function invite(app: FastifyInstance, owner: string, agentId: string, ttl = 900): Promise<{ id: string; code: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: {
      agent_id: agentId,
      scopes: ['handoff:read', 'handoff:write'],
      invitation_ttl_seconds: ttl,
      credential_ttl_seconds: 3600,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id?: string; invite_code?: string; secret_available?: boolean };
  if (body.id === undefined || body.invite_code === undefined || body.secret_available !== true) {
    throw new Error('Invitation secret was not revealed once.');
  }
  return { id: body.id, code: body.invite_code };
}

let app: FastifyInstance;
let pool: Pool;
let clock = new Date('2026-10-27T00:00:00.000Z');

beforeAll(async () => {
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required.');
  }
  pool = createPool(databaseUrl);
  await resetDisposableSchema(sqlClient(pool), process.env);
  await migrate(pool);
  app = await buildApp(identityConfig(), { now: () => clock });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('invitation issues one credential to the bound agent and keeps the previous credential', async () => {
  const owner = await session(app, 'invite-owner@example.test');
  const other = await session(app, 'invite-other@example.test');
  const agentId = await agent(app, owner, 'Bound Agent');
  const existing = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: { agent_id: agentId, scopes: ['profile:read'], ttl_seconds: 3600 },
  });
  const existingToken = (existing.json() as { token: string }).token;
  const ownersBefore = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM owners');
  const repeat = key();
  const createdResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': repeat },
    payload: {
      agent_id: agentId,
      scopes: ['handoff:read', 'handoff:write'],
      invitation_ttl_seconds: 900,
      credential_ttl_seconds: 3600,
    },
  });
  const createdBody = createdResponse.json() as { id: string; invite_code: string };
  const created = { id: createdBody.id, code: createdBody.invite_code };
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': repeat },
    payload: {
      agent_id: agentId,
      scopes: ['handoff:read', 'handoff:write'],
      invitation_ttl_seconds: 900,
      credential_ttl_seconds: 3600,
    },
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toMatchObject({ id: created.id, secret_available: false });
  expect(JSON.stringify(replay.json())).not.toContain(created.code);
  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${owner}` },
  });
  expect(JSON.stringify(listed.json())).not.toContain(created.code);
  const workspaceScope = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: {
      agent_id: agentId,
      scopes: ['workspaces:write'],
      invitation_ttl_seconds: 900,
      credential_ttl_seconds: 3600,
    },
  });
  expect(workspaceScope.statusCode).toBe(400);
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credential-invitations',
    headers: { authorization: `Bearer ${other}`, 'idempotency-key': key() },
    payload: {
      agent_id: agentId,
      scopes: ['handoff:read'],
      invitation_ttl_seconds: 900,
      credential_ttl_seconds: 3600,
    },
  });
  expect(foreign.statusCode).toBe(404);

  const attacker = binding();
  const legitimate = binding();
  const stolen = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${created.id}/present`,
    payload: { invite_code: created.code, binding_hash: attacker.hash },
  });
  expect(stolen.statusCode).toBe(200);
  const wrongConfirm = await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credential-invitations/${created.id}/confirm`,
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: { fingerprint: legitimate.fingerprint },
  });
  expect(wrongConfirm.statusCode).toBe(409);
  const rejected = await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credential-invitations/${created.id}/reject`,
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
  });
  expect(rejected.statusCode).toBe(200);
  const presented = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${created.id}/present`,
    payload: { invite_code: created.code, binding_hash: legitimate.hash },
  });
  expect(presented.statusCode).toBe(200);
  expect((presented.json() as { binding_fingerprint: string }).binding_fingerprint).toBe(legitimate.fingerprint);
  expect(JSON.stringify(presented.json())).not.toContain(created.code);
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credential-invitations/${created.id}/confirm`,
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: { fingerprint: legitimate.fingerprint },
  });
  expect(confirmed.statusCode).toBe(200);
  const first = app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${created.id}/activate`,
    payload: { binding: legitimate.value },
  });
  const second = app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${created.id}/activate`,
    payload: { binding: legitimate.value },
  });
  const [left, right] = await Promise.all([first, second]);
  const statuses = [left.statusCode, right.statusCode].sort();
  expect(statuses).toEqual([201, 409]);
  const success = left.statusCode === 201 ? left : right;
  const failure = left.statusCode === 409 ? left : right;
  const issued = success.json() as { token?: string; scopes?: string[]; agent_id?: string };
  expect(issued.token).toMatch(/^bslm_agt_/);
  expect(issued.agent_id).toBe(agentId);
  expect(issued.scopes).toEqual(['handoff:read', 'handoff:write']);
  expect(JSON.stringify(failure.json())).not.toContain(issued.token);
  const attackerUse = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${created.id}/activate`,
    payload: { binding: attacker.value },
  });
  expect(attackerUse.statusCode).toBe(404);
  const ownersAfter = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM owners');
  expect(ownersAfter.rows[0]?.count).toBe(ownersBefore.rows[0]?.count);
  const profile = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${existingToken}` },
  });
  expect(profile.statusCode).toBe(200);
  const invitedProfile = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${issued.token}` },
  });
  expect(invitedProfile.statusCode).toBe(403);
  const workspace = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'idempotency-key': key(),
    },
    payload: { goal: 'Invitation must not open a workspace.' },
  });
  expect(workspace.statusCode).toBe(403);
  const asCredential = await app.inject({
    method: 'GET',
    url: '/api/v1/agents/me',
    headers: { authorization: `Bearer ${created.code}` },
  });
  expect(asCredential.statusCode).toBe(401);
  const stored = await pool.query<{ blob: string }>('SELECT invite_hash || binding_hash || detail::text AS blob FROM credential_invitations, audit_events');
  const database = stored.rows.map((row) => row.blob).join('');
  expect(database).not.toContain(created.code);
  expect(database).not.toContain(legitimate.value);
  expect(database).not.toContain(issued.token ?? '');
});

test('revoked and expired invitations do not issue a credential', async () => {
  const owner = await session(app, 'invite-expiry@example.test');
  const agentId = await agent(app, owner, 'Expiring Agent');
  const revoked = await invite(app, owner, agentId);
  const local = binding();
  await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${revoked.id}/present`,
    payload: { invite_code: revoked.code, binding_hash: local.hash },
  });
  const removal = await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credential-invitations/${revoked.id}/revoke`,
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
  });
  expect(removal.statusCode).toBe(200);
  const afterRevoke = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${revoked.id}/activate`,
    payload: { binding: local.value },
  });
  expect(afterRevoke.statusCode).toBe(409);

  const expiring = await invite(app, owner, agentId, 60);
  const held = binding();
  const presented = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${expiring.id}/present`,
    payload: { invite_code: expiring.code, binding_hash: held.hash },
  });
  expect(presented.statusCode).toBe(200);
  await app.inject({
    method: 'POST',
    url: `/api/v1/owners/me/credential-invitations/${expiring.id}/confirm`,
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: { fingerprint: held.fingerprint },
  });
  clock = new Date(clock.getTime() + 61_000);
  const late = await app.inject({
    method: 'POST',
    url: `/api/v1/credential-invitations/${expiring.id}/activate`,
    payload: { binding: held.value },
  });
  expect(late.statusCode).toBe(409);
  expect(JSON.stringify(late.json())).not.toContain('bslm_agt_');
});
