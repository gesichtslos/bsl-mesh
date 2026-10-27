import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';
import { workspaceDuties } from '../src/workspaces/duties.js';

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';
const SKILL = {
  id: 'shared-task',
  name: 'Shared task',
  description: 'Declared skill for a closed workspace.',
  tags: ['bsl'],
};

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
  return `space-${randomBytes(8).toString('hex')}`;
}

async function sessionFor(app: FastifyInstance, email: string): Promise<string> {
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

async function agentFor(app: FastifyInstance, session: string, name: string): Promise<{ id: string; token: string }> {
  const agent = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/agents',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload: { display_name: name },
  });
  const agentId = (agent.json() as { id?: string }).id;
  const credential = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${session}`, 'idempotency-key': key() },
    payload: {
      agent_id: agentId,
      scopes: ['workspaces:read', 'workspaces:write', 'handoff:read', 'handoff:write'],
      ttl_seconds: 3600,
    },
  });
  const token = (credential.json() as { token?: string }).token;
  if (agentId === undefined || token === undefined) {
    throw new Error('Agent credential was not issued.');
  }
  return { id: agentId, token };
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
  app = await buildApp(appConfig());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('a closed workspace shares one handoff task and drops a removed member', async () => {
  const windows = await agentFor(app, await sessionFor(app, 'space-windows@example.test'), 'Windows agent');
  const linux = await agentFor(app, await sessionFor(app, 'space-linux@example.test'), 'Linux agent');
  const third = await agentFor(app, await sessionFor(app, 'space-third@example.test'), 'Third agent');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${windows.token}`, 'idempotency-key': key() },
    payload: { goal: 'Разобрать, почему обработка не открывается в предприятии.' },
  });
  expect(created.statusCode).toBe(201);
  const workspaceId = (created.json() as { id: string; state: string }).id;
  expect((created.json() as { state: string }).state).toBe('forming');
  expect(created.json()).toMatchObject({ duties: workspaceDuties(workspaceId) });
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${linux.token}` },
  });
  expect(hidden.statusCode).toBe(404);
  const invited = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { authorization: `Bearer ${windows.token}`, 'idempotency-key': key() },
    payload: { agent_id: linux.id, grant: 'contribute' },
  });
  expect(invited.statusCode).toBe(201);
  const preview = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${linux.token}` },
  });
  expect(preview.statusCode).toBe(200);
  expect(JSON.stringify(preview.json())).not.toContain('events');
  expect(preview.json()).not.toHaveProperty('duties');
  const joined = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/membership`,
    headers: { authorization: `Bearer ${linux.token}`, 'idempotency-key': key() },
  });
  expect(joined.statusCode).toBe(200);
  expect((joined.json() as { state: string }).state).toBe('active');
  expect(joined.json()).toMatchObject({ duties: workspaceDuties(workspaceId) });
  for (const agent of [windows, linux, third]) {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/v1/handoff/profile',
      headers: { authorization: `Bearer ${agent.token}`, 'idempotency-key': key() },
      payload: { availability: 'accepting', skills: [SKILL] },
    });
    expect(profile.statusCode).toBe(201);
  }
  const thirdInvite = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { authorization: `Bearer ${windows.token}`, 'idempotency-key': key() },
    payload: { agent_id: third.id, grant: 'contribute' },
  });
  expect(thirdInvite.statusCode).toBe(201);
  const thirdJoin = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/membership`,
    headers: { authorization: `Bearer ${third.token}`, 'idempotency-key': key() },
  });
  expect(thirdJoin.statusCode).toBe(200);
  const deniedAdmin = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { authorization: `Bearer ${third.token}`, 'idempotency-key': key() },
    payload: { agent_id: windows.id, grant: 'read' },
  });
  expect(deniedAdmin.statusCode).toBe(403);
  const messageId = key();
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${windows.token}`, 'idempotency-key': messageId },
    payload: {
      message: {
        messageId,
        contextId: workspaceId,
        role: 'ROLE_USER',
        parts: [{ text: 'Общая задача: сверить открытие обработки в предприятии.' }],
      },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { recipientAgentId: linux.id } },
    },
  });
  expect(sent.statusCode).toBe(201);
  const taskId = (sent.json() as { id: string; contextId: string }).id;
  expect((sent.json() as { contextId: string }).contextId).toBe(workspaceId);
  const replyId = key();
  const replied = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${linux.token}`, 'idempotency-key': replyId },
    payload: {
      message: {
        messageId: replyId,
        taskId,
        role: 'ROLE_AGENT',
        parts: [{ text: 'Уточнение записано агентом на Linux. Платформа 1С не запускалась.' }],
      },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_COMPLETED', humanParticipated: false } },
    },
  });
  expect(replied.statusCode).toBe(200);
  const thirdRead = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${third.token}` },
  });
  expect(thirdRead.statusCode).toBe(200);
  expect(JSON.stringify(thirdRead.json())).toContain('Общая задача');
  const clarificationId = key();
  const clarification = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${third.token}`, 'idempotency-key': clarificationId },
    payload: {
      message: {
        messageId: clarificationId,
        contextId: workspaceId,
        role: 'ROLE_USER',
        parts: [{ text: 'Третий агент добавляет отдельное уточнение.' }],
      },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { recipientAgentId: windows.id } },
    },
  });
  expect(clarification.statusCode).toBe(201);
  const removed = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/members/${third.id}/removal`,
    headers: { authorization: `Bearer ${windows.token}`, 'idempotency-key': key() },
  });
  expect(removed.statusCode).toBe(200);
  const removedSnapshot = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${third.token}` },
  });
  expect(removedSnapshot.statusCode).toBe(404);
  const after = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${(clarification.json() as { id: string }).id}`,
    headers: { authorization: `Bearer ${third.token}` },
  });
  expect(after.statusCode).toBe(404);
  const stillThere = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${linux.token}` },
  });
  expect(stillThere.statusCode).toBe(200);
  expect(JSON.stringify(stillThere.json())).toContain('Платформа 1С не запускалась');
});

test('workspace duties stay behind workspace scopes and an active membership', async () => {
  const owner = await sessionFor(app, 'space-duties@example.test');
  const member = await agentFor(app, owner, 'Duties member');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': key() },
    payload: { goal: 'Проверить, что правила опроса видит только участник.' },
  });
  expect(created.statusCode).toBe(201);
  const workspaceId = (created.json() as { id: string }).id;
  const mailOnly = await app.inject({
    method: 'POST',
    url: '/api/v1/owners/me/credentials',
    headers: { authorization: `Bearer ${owner}`, 'idempotency-key': key() },
    payload: {
      agent_id: member.id,
      scopes: ['handoff:read', 'handoff:write'],
      ttl_seconds: 3600,
    },
  });
  const mailToken = (mailOnly.json() as { token?: string }).token;
  if (mailToken === undefined) {
    throw new Error('Handoff credential was not issued.');
  }
  const deniedRead = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${mailToken}` },
  });
  expect(deniedRead.statusCode).toBe(403);
  const deniedCreate = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${mailToken}`, 'idempotency-key': key() },
    payload: { goal: 'Этот credential пространство не создаёт.' },
  });
  expect(deniedCreate.statusCode).toBe(403);
  const anonymous = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
  });
  expect(anonymous.statusCode).toBe(401);
  const snapshot = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${member.token}` },
  });
  expect(snapshot.statusCode).toBe(200);
  expect(snapshot.json()).toMatchObject({ duties: workspaceDuties(workspaceId) });
});
