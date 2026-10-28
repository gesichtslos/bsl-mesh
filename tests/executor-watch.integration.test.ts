import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  id: 'watch-task',
  name: 'Watch task',
  description: 'Declared skill for result watching.',
  tags: ['bsl'],
};
const ROOT = path.resolve(import.meta.dirname, '..');

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
  return `watch-${randomBytes(8).toString('hex')}`;
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

async function historyCount(app: FastifyInstance, token: string, taskId: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}?historyLength=20`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  const history = (response.json() as { history?: unknown[] }).history ?? [];
  return history.length;
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

test('the orchestrator command receives a finished artifact once and does not write into that task', async () => {
  const owner = await sessionFor(app, 'watch-owner@example.test');
  const orchestrator = await agentFor(app, owner, 'Orchestrator');
  const developer = await agentFor(app, await sessionFor(app, 'watch-developer@example.test'), 'Developer');
  for (const agent of [orchestrator, developer]) {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/v1/handoff/profile',
      headers: { authorization: `Bearer ${agent.token}`, 'idempotency-key': key() },
      payload: { availability: 'accepting', skills: [SKILL] },
    });
    expect(profile.statusCode).toBe(201);
  }
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${orchestrator.token}`, 'idempotency-key': key() },
    payload: { goal: 'Проверить наблюдение за результатом.' },
  });
  expect(created.statusCode).toBe(201);
  const workspaceId = (created.json() as { id: string }).id;
  const invited = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { authorization: `Bearer ${orchestrator.token}`, 'idempotency-key': key() },
    payload: { agent_id: developer.id, grant: 'contribute' },
  });
  expect(invited.statusCode).toBe(201);
  const joined = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/membership`,
    headers: { authorization: `Bearer ${developer.token}`, 'idempotency-key': key() },
  });
  expect(joined.statusCode).toBe(200);
  const messageId = key();
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${orchestrator.token}`, 'idempotency-key': messageId },
    payload: {
      message: {
        messageId,
        contextId: workspaceId,
        role: 'ROLE_USER',
        parts: [{ text: 'Переверни строку abc.' }],
      },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { recipientAgentId: developer.id } },
    },
  });
  expect(sent.statusCode).toBe(201);
  const taskId = (sent.json() as { id: string }).id;
  const claimId = key();
  const claim = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${developer.token}`, 'idempotency-key': claimId },
    payload: {
      message: { messageId: claimId, taskId, role: 'ROLE_AGENT', parts: [{ text: 'Беру.' }] },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_WORKING', claimToken: 'developer-claim' } },
    },
  });
  expect(claim.statusCode).toBe(200);
  const resultId = key();
  const finished = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${developer.token}`, 'idempotency-key': resultId },
    payload: {
      message: { messageId: resultId, taskId, role: 'ROLE_AGENT', parts: [{ text: 'cba' }] },
      configuration: { returnImmediately: true },
      metadata: { [EXTENSION]: { state: 'TASK_STATE_COMPLETED', humanParticipated: false } },
    },
  });
  expect(finished.statusCode).toBe(200);
  const before = await historyCount(app, orchestrator.token, taskId);
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-watch-run-'));
  const note = path.join(directory, 'notes');
  const credentialFile = path.join(directory, 'credential');
  const stateDir = path.join(directory, 'orchestrator-state');
  writeFileSync(credentialFile, `${orchestrator.token}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BSL_MESH_BASE_URL: base,
    BSL_MESH_CREDENTIAL_FILE: credentialFile,
    BSL_MESH_STATE_DIR: stateDir,
    BSL_MESH_WORKSPACE_ID: workspaceId,
    BSL_MESH_EXECUTOR_RESULT_COMMAND: JSON.stringify([
      process.execPath,
      path.join(ROOT, 'tests', 'fixtures', 'executor-watch-note.mjs'),
    ]),
    BSL_MESH_EXECUTOR_ONCE: 'true',
    BSL_MESH_EXECUTOR_INTERVAL_MS: '200',
    EXECUTOR_NOTE_FILE: note,
  };
  delete env['BSL_MESH_EXECUTOR_COMMAND'];
  const run = () => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'executor', 'main.js')], {
      env,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 1));
  });
  expect(await run()).toBe(0);
  const lines = readFileSync(note, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    taskId,
    state: 'TASK_STATE_COMPLETED',
    artifact: 'cba',
  });
  expect(await run()).toBe(0);
  expect(readFileSync(note, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(await historyCount(app, orchestrator.token, taskId)).toBe(before);
  const developerState = path.join(directory, 'developer-state', 'state.json');
  expect(() => readFileSync(developerState, 'utf8')).toThrow();
});
