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
  id: 'executor-task',
  name: 'Executor task',
  description: 'Declared skill for the local executor.',
  tags: ['bsl'],
};
const ROOT = path.resolve(import.meta.dirname, '..');
const EXECUTOR_BIN = path.join(ROOT, 'dist', 'executor', 'main.js');
const pids: number[] = [];

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
  return `exec-${randomBytes(8).toString('hex')}`;
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

async function workspaceFor(app: FastifyInstance, token: string, goal: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key() },
    payload: { goal },
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

function countLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function executorEnv(input: {
  base: string;
  credentialFile: string;
  stateDir: string;
  workspaceId: string;
  command: string[];
  once?: boolean;
  extra?: Record<string, string>;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BSL_MESH_BASE_URL: input.base,
    BSL_MESH_CREDENTIAL_FILE: input.credentialFile,
    BSL_MESH_STATE_DIR: input.stateDir,
    BSL_MESH_WORKSPACE_ID: input.workspaceId,
    BSL_MESH_EXECUTOR_COMMAND: JSON.stringify(input.command),
    BSL_MESH_EXECUTOR_INTERVAL_MS: '200',
    BSL_MESH_EXECUTOR_COMMAND_TIMEOUT_MS: '20000',
    BSL_MESH_EXECUTOR_ONCE: input.once === true ? 'true' : 'false',
    ...input.extra,
  };
}

async function runSession(env: NodeJS.ProcessEnv, directory: string): Promise<{ pid: number; endedAt: string }> {
  const pidFile = path.join(directory, 'executor.pid');
  const endedFile = path.join(directory, 'session-ended-at');
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'fixtures', 'executor-session.mjs')], {
      env: {
        ...env,
        EXECUTOR_BIN: EXECUTOR_BIN,
        EXECUTOR_PID_FILE: pidFile,
        EXECUTOR_STARTED_FILE: path.join(env['BSL_MESH_STATE_DIR'] ?? '', 'started-at'),
        SESSION_ENDED_FILE: endedFile,
      },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 1));
  });
  expect(code).toBe(0);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(alive(pid)).toBe(true);
  pids.push(pid);
  return { pid, endedAt: readFileSync(endedFile, 'utf8').trim() };
}

async function sendTask(app: FastifyInstance, token: string, recipientId: string, workspaceId: string, text: string, visibleAt: string | undefined): Promise<string> {
  const messageId = key();
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/handoff/messages',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': messageId },
    payload: {
      message: {
        messageId,
        contextId: workspaceId,
        role: 'ROLE_USER',
        parts: [{ text }],
      },
      configuration: { returnImmediately: true },
      metadata: {
        [EXTENSION]: {
          recipientAgentId: recipientId,
          ...(visibleAt === undefined ? {} : { visibleAt }),
        },
      },
    },
  });
  expect(sent.statusCode).toBe(201);
  return (sent.json() as { id: string }).id;
}

async function taskOf(app: FastifyInstance, token: string, taskId: string): Promise<{
  state: string;
  timestamp: string;
  artifact: string;
  agentMessages: number;
  claimToken: string | null;
  humanParticipated: boolean | undefined;
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks/${taskId}?historyLength=20`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    status?: { state?: string; timestamp?: string };
    artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
    history?: Array<{ role?: string }>;
    metadata?: Record<string, { claimToken?: string; humanParticipated?: boolean }>;
  };
  return {
    state: body.status?.state ?? '',
    timestamp: body.status?.timestamp ?? '',
    artifact: body.artifacts?.[0]?.parts?.map((part) => part.text ?? '').join('\n') ?? '',
    agentMessages: (body.history ?? []).filter((item) => item.role === 'ROLE_AGENT').length,
    claimToken: body.metadata?.[EXTENSION]?.claimToken ?? null,
    humanParticipated: body.metadata?.[EXTENSION]?.humanParticipated,
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
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process has already exited.
      }
    }
  }
  await app?.close();
  await pool?.end();
});

test('the executor finds a task only after the setup session exits and publishes the command result', async () => {
  const sender = await agentFor(app, await sessionFor(app, 'exec-sender@example.test'), 'Orchestrator');
  const recipient = await agentFor(app, await sessionFor(app, 'exec-recipient@example.test'), 'Developer');
  const idle = await agentFor(app, await sessionFor(app, 'exec-idle@example.test'), 'Idle');
  for (const agent of [sender, recipient, idle]) {
    await profile(app, agent.token);
  }
  const workspaceId = await workspaceFor(app, sender.token, 'Проверить автономный исполнитель.');
  await join(app, sender.token, workspaceId, recipient);
  await join(app, sender.token, workspaceId, idle);
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-run-'));
  const stateDir = path.join(directory, 'state');
  const credentialFile = path.join(directory, 'credential');
  const countFile = path.join(directory, 'runs');
  writeFileSync(credentialFile, `${recipient.token}\n`, { mode: 0o600 });
  const env = executorEnv({
    base,
    credentialFile,
    stateDir,
    workspaceId,
    command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'executor-echo.mjs')],
    extra: { EXECUTOR_COUNT_FILE: countFile },
  });
  const session = await runSession(env, directory);
  const startedAt = readFileSync(path.join(stateDir, 'started-at'), 'utf8').trim();
  expect(Date.parse(startedAt)).toBeLessThanOrEqual(Date.parse(session.endedAt));
  const visibleAt = new Date(Date.parse(session.endedAt) + 2000).toISOString();
  const taskText = 'Reply with the token mesh-local-ok.';
  const taskId = await sendTask(app, sender.token, recipient.id, workspaceId, taskText, visibleAt);
  const idleId = await sendTask(app, sender.token, idle.id, workspaceId, 'Health checks must leave this task waiting.', visibleAt);
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/v1/handoff/tasks?role=recipient&state=TASK_STATE_SUBMITTED&contextId=${workspaceId}&historyLength=0`,
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  expect(hidden.statusCode).toBe(200);
  expect(JSON.stringify(hidden.json())).not.toContain(taskId);
  let healthChecks = 0;
  const deadline = Date.now() + 12_000;
  let done = false;
  while (Date.now() < deadline) {
    const health = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(health.statusCode).toBe(200);
    healthChecks += 1;
    const current = await taskOf(app, sender.token, taskId);
    if (current.state === 'TASK_STATE_COMPLETED') {
      expect(current.artifact).toBe(`done:${taskText}`);
      expect(Date.parse(current.timestamp)).toBeGreaterThan(Date.parse(visibleAt));
      expect(current.agentMessages).toBe(2);
      expect(current.claimToken).toMatch(/^executor-[a-f0-9]{16}$/);
      done = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(done).toBe(true);
  expect(healthChecks).toBeGreaterThan(0);
  expect(countLines(countFile)).toEqual(['1']);
  const idleTask = await taskOf(app, sender.token, idleId);
  expect(idleTask.state).toBe('TASK_STATE_SUBMITTED');
  expect(idleTask.artifact).toBe('');
  expect(idleTask.humanParticipated).toBeUndefined();
}, 20_000);

test('stopping the executor after claim does not run the command a second time', async () => {
  const sender = await agentFor(app, await sessionFor(app, 'exec-stop-sender@example.test'), 'Stop sender');
  const recipient = await agentFor(app, await sessionFor(app, 'exec-stop-recipient@example.test'), 'Stop recipient');
  await profile(app, sender.token);
  await profile(app, recipient.token);
  const workspaceId = await workspaceFor(app, sender.token, 'Проверить однократный захват.');
  await join(app, sender.token, workspaceId, recipient);
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-stop-'));
  const stateDir = path.join(directory, 'state');
  const credentialFile = path.join(directory, 'credential');
  const countFile = path.join(directory, 'runs');
  writeFileSync(credentialFile, `${recipient.token}\n`, { mode: 0o600 });
  const env = executorEnv({
    base,
    credentialFile,
    stateDir,
    workspaceId,
    command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'executor-hold.mjs')],
    extra: { EXECUTOR_COUNT_FILE: countFile },
  });
  const child = spawn(process.execPath, [EXECUTOR_BIN], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The executor did not start.');
  }
  pids.push(pid);
  const taskId = await sendTask(app, sender.token, recipient.id, workspaceId, 'Hold this task.', undefined);
  const started = Date.now();
  while (!countLines(countFile).includes('1') && Date.now() - started < 8000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(countLines(countFile)).toEqual(['1']);
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  process.kill(-pid, 'SIGKILL');
  await closed;
  const restart = spawn(process.execPath, [EXECUTOR_BIN], {
    env: { ...env, BSL_MESH_EXECUTOR_ONCE: 'true' },
    stdio: 'ignore',
  });
  const code = await new Promise<number>((resolve, reject) => {
    restart.on('error', reject);
    restart.on('close', (status) => resolve(status ?? 1));
  });
  expect(code).toBe(0);
  expect(countLines(countFile)).toEqual(['1']);
  const task = await taskOf(app, sender.token, taskId);
  expect(task.state).toBe('TASK_STATE_WORKING');
  expect(task.artifact).toBe('');
  expect(task.agentMessages).toBe(1);
}, 20_000);

test.skipIf(process.env['BSL_MESH_EXECUTOR_CURSOR'] !== '1')('a Cursor command performs a new task after the setup session exits', async () => {
  const sender = await agentFor(app, await sessionFor(app, 'exec-cursor-sender@example.test'), 'Cursor sender');
  const recipient = await agentFor(app, await sessionFor(app, 'exec-cursor-recipient@example.test'), 'Cursor recipient');
  await profile(app, sender.token);
  await profile(app, recipient.token);
  const workspaceId = await workspaceFor(app, sender.token, 'Проверить вызов модели.');
  await join(app, sender.token, workspaceId, recipient);
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-cursor-'));
  const stateDir = path.join(directory, 'state');
  const credentialFile = path.join(directory, 'credential');
  const evidenceFile = path.join(directory, 'model-evidence.json');
  const workspace = process.env['EXECUTOR_MODEL_WORKSPACE'] ?? mkdtempSync(path.join(tmpdir(), 'bslmesh-cursor-workspace-'));
  writeFileSync(credentialFile, `${recipient.token}\n`, { mode: 0o600 });
  const env = executorEnv({
    base,
    credentialFile,
    stateDir,
    workspaceId,
    command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'executor-cursor-command.mjs')],
    extra: {
      EXECUTOR_MODEL_BIN: process.env['EXECUTOR_MODEL_BIN'] ?? 'agent',
      EXECUTOR_MODEL_WORKSPACE: workspace,
      EXECUTOR_MODEL_EVIDENCE: evidenceFile,
      BSL_MESH_EXECUTOR_COMMAND_TIMEOUT_MS: '150000',
    },
  });
  const session = await runSession(env, directory);
  const visibleAt = new Date(Date.parse(session.endedAt) + 1500).toISOString();
  const taskId = await sendTask(app, sender.token, recipient.id, workspaceId, 'Reply with exactly mesh-executor-ok.', visibleAt);
  const deadline = Date.now() + 150_000;
  let done = false;
  while (Date.now() < deadline) {
    const current = await taskOf(app, sender.token, taskId);
    if (current.state === 'TASK_STATE_COMPLETED') {
      expect(current.artifact).toContain('mesh-executor-ok');
      expect(Date.parse(current.timestamp)).toBeGreaterThan(Date.parse(visibleAt));
      expect(current.agentMessages).toBe(2);
      done = true;
      break;
    }
    if (current.state === 'TASK_STATE_WORKING' && current.artifact === '') {
      const journal = path.join(stateDir, 'state.json');
      try {
        const phase = (JSON.parse(readFileSync(journal, 'utf8')) as { tasks: Record<string, { phase: string }> }).tasks[taskId]?.phase;
        if (phase === 'uncertain') {
          break;
        }
      } catch {
        // The journal is not written yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as {
    modelCalls: number | null;
    durationApiMs: number | null;
    hasUsage: boolean;
    result: string;
    exitCode: number;
  };
  expect(evidence.exitCode).toBe(0);
  expect(evidence.result).toContain('mesh-executor-ok');
  expect(evidence.modelCalls !== null || evidence.durationApiMs !== null || evidence.hasUsage).toBe(true);
  expect(done).toBe(true);
}, 180_000);
