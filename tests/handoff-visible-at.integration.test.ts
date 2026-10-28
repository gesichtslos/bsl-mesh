import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { resetDisposableSchema, type SqlClient } from '../src/db/test-database.js';

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';
const SKILL = {
  id: 'shared-task',
  name: 'Shared task',
  description: 'Declared skill for a delayed workspace task.',
  tags: ['bsl'],
};

let current = new Date('2026-10-28T10:00:00.000Z');

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
  return `later-${randomBytes(8).toString('hex')}`;
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

async function profile(app: FastifyInstance, token: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/profile',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key() },
    payload: { availability: 'accepting', skills: [SKILL] },
  });
  expect(response.statusCode).toBe(201);
}

async function workspaceFor(app: FastifyInstance, token: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key() },
    payload: { goal: 'Проверить отложенную задачу роя.' },
  });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as { id?: string }).id;
  if (id === undefined) {
    throw new Error('Workspace was not created.');
  }
  return id;
}

async function join(app: FastifyInstance, admin: string, workspaceId: string, agent: { id: string; token: string }): Promise<void> {
  const invited = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { authorization: `Bearer ${admin}`, 'idempotency-key': key() },
    payload: { agent_id: agent.id, grant: 'contribute' },
  });
  expect(invited.statusCode).toBe(201);
  const joined = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/membership`,
    headers: { authorization: `Bearer ${agent.token}`, 'idempotency-key': key() },
  });
  expect(joined.statusCode).toBe(200);
}

function message(messageId: string, recipientId: string, contextId: string | undefined, text: string, visibleAt: string | undefined) {
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ text }],
      ...(contextId === undefined ? {} : { contextId }),
    },
    configuration: { returnImmediately: true },
    metadata: {
      [EXTENSION]: {
        recipientAgentId: recipientId,
        ...(visibleAt === undefined ? {} : { visibleAt }),
      },
    },
  };
}

async function listedIds(app: FastifyInstance, token: string, workspaceId: string | undefined, role: string): Promise<string[]> {
  const query = new URLSearchParams({ role, state: 'TASK_STATE_SUBMITTED', historyLength: '0' });
  if (workspaceId !== undefined) {
    query.set('contextId', workspaceId);
  }
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks?${query.toString()}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  const tasks = (response.json() as { tasks?: Array<{ id?: string }> }).tasks ?? [];
  return tasks.flatMap((task) => (typeof task.id === 'string' ? [task.id] : []));
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
  app = await buildApp(appConfig(), { now: () => current });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

test('a workspace task stays hidden from everyone except the sender until visibleAt, then claims once', async () => {
  current = new Date('2026-10-28T10:00:00.000Z');
  const sender = await agentFor(app, await sessionFor(app, 'later-sender@example.test'), 'Orchestrator');
  const recipient = await agentFor(app, await sessionFor(app, 'later-recipient@example.test'), 'Developer');
  const observer = await agentFor(app, await sessionFor(app, 'later-observer@example.test'), 'Tester');
  const stranger = await agentFor(app, await sessionFor(app, 'later-stranger@example.test'), 'Outsider');
  for (const agent of [sender, recipient, observer, stranger]) {
    await profile(app, agent.token);
  }
  const workspaceId = await workspaceFor(app, sender.token);
  await join(app, sender.token, workspaceId, recipient);
  await join(app, sender.token, workspaceId, observer);
  const otherWorkspace = await workspaceFor(app, stranger.token);
  const visibleAt = '2026-10-28T10:05:00Z';
  const immediateId = key();
  const immediate = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': immediateId },
    payload: message(immediateId, recipient.id, workspaceId, 'Сразу.', undefined),
  });
  expect(immediate.statusCode).toBe(201);
  const immediateTask = (immediate.json() as { id: string }).id;
  const messageId = key();
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': messageId },
    payload: message(messageId, recipient.id, workspaceId, 'После повторного подключения.', visibleAt),
  });
  expect(sent.statusCode).toBe(201);
  const taskId = (sent.json() as { id: string }).id;
  expect(sent.json()).toMatchObject({
    status: { state: 'TASK_STATE_SUBMITTED' },
    contextId: workspaceId,
    metadata: { [EXTENSION]: { visibleAt: '2026-10-28T10:05:00.000Z' } },
  });
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': messageId },
    payload: message(messageId, recipient.id, workspaceId, 'После повторного подключения.', visibleAt),
  });
  expect(replay.statusCode).toBe(200);
  expect((replay.json() as { id: string }).id).toBe(taskId);
  const changed = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': messageId },
    payload: message(messageId, recipient.id, workspaceId, 'После повторного подключения.', '2026-10-28T11:00:00Z'),
  });
  expect(changed.statusCode).toBe(409);
  const brokenId = key();
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': brokenId },
    payload: message(brokenId, recipient.id, workspaceId, 'Сломанный срок.', '2026-02-31T00:00:00.000Z'),
  });
  expect(invalid.statusCode).toBe(422);
  expect(await listedIds(app, recipient.token, workspaceId, 'recipient')).toEqual([immediateTask]);
  expect(await listedIds(app, observer.token, workspaceId, 'recipient')).toEqual([]);
  expect(await listedIds(app, stranger.token, workspaceId, 'recipient')).toEqual([]);
  expect(await listedIds(app, stranger.token, otherWorkspace, 'recipient')).toEqual([]);
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  expect(hidden.statusCode).toBe(404);
  const hiddenObserver = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${observer.token}` },
  });
  expect(hiddenObserver.statusCode).toBe(404);
  const hiddenStranger = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${stranger.token}` },
  });
  expect(hiddenStranger.statusCode).toBe(404);
  const earlyClaimId = key();
  const earlyClaim = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${recipient.token}`, 'idempotency-key': earlyClaimId },
    payload: {
      message: { messageId: earlyClaimId, taskId, role: 'ROLE_AGENT', parts: [{ text: 'Рано.' }] },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_WORKING', claimToken: 'early-claim-token' } },
    },
  });
  expect(earlyClaim.statusCode).toBe(404);
  const senderView = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${sender.token}` },
  });
  expect(senderView.statusCode).toBe(200);
  expect(senderView.json()).toMatchObject({
    status: { state: 'TASK_STATE_SUBMITTED' },
    metadata: { [EXTENSION]: { visibleAt: '2026-10-28T10:05:00.000Z' } },
  });
  expect(JSON.stringify(senderView.json())).not.toContain('receivedAt');
  current = new Date('2026-10-28T10:05:00.000Z');
  const discovered = await listedIds(app, recipient.token, workspaceId, 'recipient');
  expect(discovered).toContain(taskId);
  expect(discovered).toContain(immediateTask);
  const read = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  expect(read.statusCode).toBe(200);
  expect(JSON.stringify(read.json())).toContain('После повторного подключения.');
  expect(read.json()).toMatchObject({
    status: { state: 'TASK_STATE_SUBMITTED' },
    metadata: { [EXTENSION]: { receivedAt: '2026-10-28T10:05:00.000Z' } },
  });
  const observerRead = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${observer.token}` },
  });
  expect(observerRead.statusCode).toBe(200);
  const stillHidden = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${stranger.token}` },
  });
  expect(stillHidden.statusCode).toBe(404);
  const claimId = key();
  const claim = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${recipient.token}`, 'idempotency-key': claimId },
    payload: {
      message: { messageId: claimId, taskId, role: 'ROLE_AGENT', parts: [{ text: 'Беру задачу.' }] },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_WORKING', claimToken: 'once-claim-token' } },
    },
  });
  expect(claim.statusCode).toBe(200);
  expect(claim.json()).toMatchObject({ status: { state: 'TASK_STATE_WORKING' } });
  const secondId = key();
  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${recipient.token}`, 'idempotency-key': secondId },
    payload: {
      message: { messageId: secondId, taskId, role: 'ROLE_AGENT', parts: [{ text: 'Беру ещё раз.' }] },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_WORKING', claimToken: 'twice-claim-token' } },
    },
  });
  expect(second.statusCode).toBe(409);
  const after = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${sender.token}` },
  });
  expect(after.json()).toMatchObject({
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { [EXTENSION]: { claimToken: 'once-claim-token' } },
  });
});

test('a pairwise delayed task uses the same mailbox and stays hidden from the recipient', async () => {
  current = new Date('2026-10-28T12:00:00.000Z');
  const sender = await agentFor(app, await sessionFor(app, 'later-pair-sender@example.test'), 'Pair sender');
  const recipient = await agentFor(app, await sessionFor(app, 'later-pair-recipient@example.test'), 'Pair recipient');
  await profile(app, sender.token);
  await profile(app, recipient.token);
  const allowed = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/allowances',
    headers: { authorization: `Bearer ${recipient.token}`, 'idempotency-key': key() },
    payload: { sender_agent_id: sender.id },
  });
  expect(allowed.statusCode).toBe(201);
  const messageId = key();
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${sender.token}`, 'idempotency-key': messageId },
    payload: message(messageId, recipient.id, undefined, 'Парная отложенная задача.', '2026-10-28T12:10:00Z'),
  });
  expect(sent.statusCode).toBe(201);
  const taskId = (sent.json() as { id: string }).id;
  expect(await listedIds(app, recipient.token, undefined, 'recipient')).not.toContain(taskId);
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}`,
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  expect(hidden.statusCode).toBe(404);
  current = new Date('2026-10-28T12:10:00.000Z');
  expect(await listedIds(app, recipient.token, undefined, 'recipient')).toContain(taskId);
});
