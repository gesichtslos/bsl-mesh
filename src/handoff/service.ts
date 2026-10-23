import type { Pool, PoolClient } from 'pg';

import type { AppConfig } from '../config.js';
import { auditDetail } from '../identity/audit.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { uuidV7 } from '../identity/ids.js';
import type { AgentPrincipal, IdentityService } from '../identity/service.js';
import { hashRequest, sameDigest } from '../identity/tokens.js';
import { assertWorkspaceRead, assertWorkspaceSend, WORKSPACE_TASK_FILTER } from '../workspaces/access.js';
import {
  HANDOFF_EXTENSION,
  type EscalationReason,
  type Part,
  type SendDraft,
  type Skill,
  type TaskState,
} from './parse.js';

const TERMINAL = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

const RECIPIENT_NEXT = new Set([
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
]);

type TaskRow = {
  id: string;
  context_id: string;
  requester_agent_id: string;
  requester_owner_id: string;
  recipient_agent_id: string;
  recipient_owner_id: string;
  state: TaskState;
  status_timestamp: Date;
  metadata: Record<string, unknown>;
  source_kind: 'organic' | 'synthetic' | 'import';
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  message_id: string;
  author_owner_id: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  created_at: Date;
};

type ArtifactRow = {
  id: string;
  parts: Part[];
};

export class HandoffService {
  constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
    private readonly now: () => Date,
  ) {}

  async saveProfile(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    availability: 'accepting' | 'paused';
    skills: Skill[];
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ availability: input.availability, skills: input.skills });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'handoff.profile', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const current = this.now();
      await client.query(
        `INSERT INTO handoff_profiles (agent_id, owner_id, availability, skills, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (agent_id) DO UPDATE
           SET availability = EXCLUDED.availability, skills = EXCLUDED.skills, updated_at = EXCLUDED.updated_at`,
        [principal.agentId, principal.ownerId, input.availability, JSON.stringify(input.skills), current],
      );
      const body = await this.cardFor(client, principal.agentId, principal.ownerId);
      await this.audit(client, principal, 'handoff.profile', 'success', input.requestId, { agent_id: principal.agentId });
      await this.finishIdempotent(client, principal.ownerId, 'handoff.profile', input.idempotencyKey, body, 201);
      return { statusCode: 201, body };
    });
  }

  async allowSender(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    senderAgentId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ senderAgentId: input.senderAgentId });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'handoff.allow', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const profile = await client.query(`SELECT 1 FROM handoff_profiles WHERE agent_id = $1`, [principal.agentId]);
      if ((profile.rowCount ?? 0) === 0) {
        throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
      }
      const sender = await this.activeAgent(client, input.senderAgentId);
      if (sender === null || sender.id === principal.agentId) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      await client.query(
        `INSERT INTO handoff_allowances (
           recipient_agent_id, recipient_owner_id, sender_agent_id, sender_owner_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (recipient_agent_id, sender_agent_id) DO NOTHING`,
        [principal.agentId, principal.ownerId, sender.id, sender.owner_id, this.now()],
      );
      const body = { recipient_agent_id: principal.agentId, sender_agent_id: sender.id };
      await this.audit(client, principal, 'handoff.allow', 'success', input.requestId, { peer_agent_id: sender.id });
      await this.finishIdempotent(client, principal.ownerId, 'handoff.allow', input.idempotencyKey, body, 201);
      return { statusCode: 201, body };
    });
  }

  async listAddressable(accessToken: string, requestId: string): Promise<{ items: Record<string, unknown>[] }> {
    this.enabled();
    const principal = await this.reader(accessToken, requestId);
    const rows = await this.pool.query<{ agent_id: string; owner_id: string }>(
      `SELECT recipient_agent_id AS agent_id, recipient_owner_id AS owner_id
       FROM handoff_allowances
       WHERE sender_agent_id = $1
       ORDER BY recipient_agent_id`,
      [principal.agentId],
    );
    const items = [];
    for (const row of rows.rows) {
      items.push(await this.cardFor(this.pool, row.agent_id, row.owner_id));
    }
    return { items };
  }

  async getCard(accessToken: string, requestId: string, agentId: string): Promise<Record<string, unknown>> {
    this.enabled();
    const principal = await this.reader(accessToken, requestId);
    const allowed = await this.pool.query(
      `SELECT 1 FROM handoff_allowances
       WHERE sender_agent_id = $1 AND recipient_agent_id = $2
       UNION ALL
       SELECT 1 FROM agents WHERE id = $2 AND id = $1`,
      [principal.agentId, agentId],
    );
    if ((allowed.rowCount ?? 0) === 0) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const agent = await this.pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM agents WHERE id = $1 AND status = 'active'`,
      [agentId],
    );
    const row = agent.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return this.cardFor(this.pool, agentId, row.owner_id);
  }

  async send(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    draft: SendDraft;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    if (input.draft.message.messageId !== input.idempotencyKey) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const requestHash = hashRequest(input.draft);
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'handoff.send', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const body = input.draft.message.taskId === undefined
        ? await this.createTask(client, principal, input.draft, input.requestId)
        : await this.continueTask(client, principal, input.draft, input.requestId);
      await this.finishIdempotent(client, principal.ownerId, 'handoff.send', input.idempotencyKey, body, input.draft.message.taskId === undefined ? 201 : 200);
      return { statusCode: input.draft.message.taskId === undefined ? 201 : 200, body };
    });
  }

  async getTask(input: {
    accessToken: string;
    requestId: string;
    taskId: string;
    historyLength: number | undefined;
  }): Promise<Record<string, unknown>> {
    this.enabled();
    const principal = await this.reader(input.accessToken, input.requestId);
    return this.transaction(async (client) => {
      const task = await this.visibleTask(client, input.taskId, principal.agentId, true);
      await assertWorkspaceRead(client, task.context_id, principal.agentId);
      if (task.recipient_agent_id === principal.agentId && task.metadata['receivedAt'] === undefined) {
        const receivedAt = this.now().toISOString();
        await client.query(
          `UPDATE handoff_tasks
           SET metadata = metadata || $2::jsonb
           WHERE id = $1 AND metadata ->> 'receivedAt' IS NULL`,
          [task.id, JSON.stringify({ receivedAt })],
        );
        task.metadata = { ...task.metadata, receivedAt };
      }
      return this.present(client, task, input.historyLength);
    });
  }

  async listTasks(input: {
    accessToken: string;
    requestId: string;
    contextId: string | undefined;
    pageSize: number;
    historyLength: number | undefined;
  }): Promise<{ tasks: Record<string, unknown>[]; pageSize: number; nextPageToken: null }> {
    this.enabled();
    const principal = await this.reader(input.accessToken, input.requestId);
    const rows = await this.pool.query<TaskRow>(
      `SELECT id, context_id, requester_agent_id, requester_owner_id, recipient_agent_id, recipient_owner_id,
              state, status_timestamp, metadata, source_kind, created_at, updated_at
       FROM handoff_tasks
       WHERE (
         requester_agent_id = $1 OR recipient_agent_id = $1
         OR EXISTS (
           SELECT 1 FROM workspace_members
           WHERE workspace_id = handoff_tasks.context_id
             AND agent_id = $1
             AND status = 'active'
         )
       )
         AND ($2::uuid IS NULL OR context_id = $2)
         ${WORKSPACE_TASK_FILTER}
       ORDER BY updated_at DESC, id DESC
       LIMIT $3`,
      [principal.agentId, input.contextId ?? null, input.pageSize],
    );
    const tasks = [];
    for (const row of rows.rows) {
      tasks.push(await this.present(this.pool, row, input.historyLength));
    }
    return { tasks, pageSize: input.pageSize, nextPageToken: null };
  }

  async cancel(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    taskId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ taskId: input.taskId, action: 'cancel' });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'handoff.cancel', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const task = await this.visibleTask(client, input.taskId, principal.agentId, true);
      await assertWorkspaceRead(client, task.context_id, principal.agentId);
      if (task.requester_agent_id !== principal.agentId || TERMINAL.has(task.state)) {
        throw new IdentityError(400, 'Bad Request', 'UnsupportedOperationError');
      }
      const current = this.now();
      await client.query(
        `UPDATE handoff_tasks
         SET state = 'TASK_STATE_CANCELED', status_timestamp = $2, updated_at = $2
         WHERE id = $1`,
        [task.id, current],
      );
      task.state = 'TASK_STATE_CANCELED';
      task.status_timestamp = current;
      const body = await this.present(client, task, undefined);
      await this.audit(client, principal, 'handoff.cancel', 'success', input.requestId, { task_id: task.id });
      await this.finishIdempotent(client, principal.ownerId, 'handoff.cancel', input.idempotencyKey, body, 200);
      return { statusCode: 200, body };
    });
  }

  private async createTask(
    client: PoolClient,
    principal: AgentPrincipal,
    draft: SendDraft,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    if (draft.message.role !== 'ROLE_USER' || draft.directive.recipientAgentId === undefined || draft.directive.state !== undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const recipientId = draft.directive.recipientAgentId;
    const workspaceBound = draft.message.contextId !== undefined
      && await assertWorkspaceSend(client, draft.message.contextId, principal.agentId, recipientId);
    const allowed = workspaceBound
      ? await client.query<{ owner_id: string; availability: 'accepting' | 'paused' }>(
        `SELECT recipient.owner_id, profile.availability
         FROM agents AS recipient
         JOIN handoff_profiles AS profile ON profile.agent_id = recipient.id
         WHERE recipient.id = $1 AND recipient.status = 'active'`,
        [recipientId],
      )
      : await client.query<{ owner_id: string; availability: 'accepting' | 'paused' }>(
        `SELECT allowance.recipient_owner_id AS owner_id, profile.availability
         FROM handoff_allowances AS allowance
         JOIN agents AS recipient ON recipient.id = allowance.recipient_agent_id AND recipient.status = 'active'
         JOIN handoff_profiles AS profile ON profile.agent_id = recipient.id
         WHERE allowance.sender_agent_id = $1 AND allowance.recipient_agent_id = $2`,
        [principal.agentId, recipientId],
      );
    const recipient = allowed.rows[0];
    if (recipient === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const current = this.now();
    const taskId = uuidV7(current);
    const contextId = draft.message.contextId ?? uuidV7(new Date(current.getTime() + 1));
    const state: TaskState = recipient.availability === 'paused' ? 'TASK_STATE_REJECTED' : 'TASK_STATE_SUBMITTED';
    const metadata = { sourceKind: this.config.knowledgeSourceKind };
    await client.query(
      `INSERT INTO handoff_tasks (
         id, context_id, requester_agent_id, requester_owner_id, recipient_agent_id, recipient_owner_id,
         state, status_timestamp, metadata, source_kind, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $8, $8)`,
      [
        taskId,
        contextId,
        principal.agentId,
        principal.ownerId,
        recipientId,
        recipient.owner_id,
        state,
        current,
        JSON.stringify(metadata),
        this.config.knowledgeSourceKind,
      ],
    );
    await this.insertMessage(client, principal, taskId, draft, current);
    await this.audit(client, principal, 'handoff.send', 'success', requestId, { task_id: taskId, peer_agent_id: recipientId });
    const task = await this.visibleTask(client, taskId, principal.agentId, false);
    return this.present(client, task, undefined);
  }

  private async continueTask(
    client: PoolClient,
    principal: AgentPrincipal,
    draft: SendDraft,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const taskId = draft.message.taskId;
    if (taskId === undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const task = await this.visibleTask(client, taskId, principal.agentId, true);
    await assertWorkspaceRead(client, task.context_id, principal.agentId);
    if (principal.agentId === task.recipient_agent_id && draft.directive.state !== undefined) {
      await assertWorkspaceSend(client, task.context_id, principal.agentId, task.requester_agent_id);
    }
    if (draft.message.contextId !== undefined && draft.message.contextId !== task.context_id) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    if (TERMINAL.has(task.state)) {
      throw new IdentityError(400, 'Bad Request', 'UnsupportedOperationError');
    }
    const current = this.now();
    if (principal.agentId === task.requester_agent_id) {
      if (draft.message.role !== 'ROLE_USER' || draft.directive.state !== undefined) {
        throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
      }
      await this.insertMessage(client, principal, task.id, draft, current);
    } else if (principal.agentId === task.recipient_agent_id) {
      if (draft.message.role !== 'ROLE_AGENT' || draft.directive.state === undefined) {
        throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
      }
      this.assertTransition(task.state, draft.directive.state);
      this.assertEscalation(draft.directive.state, draft.directive.escalationReason);
      await this.insertMessage(client, principal, task.id, draft, current);
      if (draft.directive.state === 'TASK_STATE_COMPLETED' || draft.directive.state === 'TASK_STATE_FAILED') {
        await client.query(
          `INSERT INTO handoff_artifacts (id, task_id, parts, created_at) VALUES ($1, $2, $3::jsonb, $4)`,
          [uuidV7(new Date(current.getTime() + 1)), task.id, JSON.stringify(draft.message.parts), current],
        );
      }
      const metadata = {
        ...task.metadata,
        humanParticipated: draft.directive.humanParticipated ?? false,
        ...(draft.directive.escalationReason !== undefined ? { escalationReason: draft.directive.escalationReason } : {}),
      };
      await client.query(
        `UPDATE handoff_tasks
         SET state = $2, status_timestamp = $3, updated_at = $3, metadata = $4::jsonb
         WHERE id = $1`,
        [task.id, draft.directive.state, current, JSON.stringify(metadata)],
      );
      task.state = draft.directive.state;
      task.status_timestamp = current;
      task.metadata = metadata;
    } else {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    await this.audit(client, principal, 'handoff.reply', 'success', requestId, { task_id: task.id });
    return this.present(client, task, undefined);
  }

  private assertTransition(current: TaskState, next: TaskState): void {
    if (current === 'TASK_STATE_SUBMITTED' && RECIPIENT_NEXT.has(next)) {
      return;
    }
    if (current === 'TASK_STATE_WORKING' && RECIPIENT_NEXT.has(next)) {
      return;
    }
    if ((current === 'TASK_STATE_INPUT_REQUIRED' || current === 'TASK_STATE_AUTH_REQUIRED')
      && (next === 'TASK_STATE_WORKING' || next === 'TASK_STATE_COMPLETED' || next === 'TASK_STATE_FAILED' || next === 'TASK_STATE_REJECTED')) {
      return;
    }
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }

  private assertEscalation(state: TaskState, reason: EscalationReason | undefined): void {
    const needsReason = state === 'TASK_STATE_INPUT_REQUIRED' || state === 'TASK_STATE_AUTH_REQUIRED';
    if (needsReason && reason === undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    if (!needsReason && reason !== undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
  }

  private async insertMessage(
    client: PoolClient,
    principal: AgentPrincipal,
    taskId: string,
    draft: SendDraft,
    current: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO handoff_messages (message_id, author_owner_id, author_agent_id, task_id, role, parts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [draft.message.messageId, principal.ownerId, principal.agentId, taskId, draft.message.role, JSON.stringify(draft.message.parts), current],
    );
  }

  private async visibleTask(client: PoolClient | Pool, taskId: string, agentId: string, lock: boolean): Promise<TaskRow> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const result = await client.query<TaskRow>(
      `SELECT id, context_id, requester_agent_id, requester_owner_id, recipient_agent_id, recipient_owner_id,
              state, status_timestamp, metadata, source_kind, created_at, updated_at
       FROM handoff_tasks
       WHERE id = $1 AND (
         requester_agent_id = $2 OR recipient_agent_id = $2
         OR EXISTS (
           SELECT 1 FROM workspace_members
           WHERE workspace_id = handoff_tasks.context_id
             AND agent_id = $2
             AND status = 'active'
         )
       )
       ${lock ? 'FOR UPDATE' : ''}`,
      [taskId, agentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return row;
  }

  private async present(client: PoolClient | Pool, task: TaskRow, historyLength: number | undefined): Promise<Record<string, unknown>> {
    const messages = await client.query<MessageRow>(
      `SELECT message_id, author_owner_id, role, parts, created_at
       FROM handoff_messages
       WHERE task_id = $1
       ORDER BY created_at ASC, message_id ASC`,
      [task.id],
    );
    const artifacts = await client.query<ArtifactRow>(
      `SELECT id, parts FROM handoff_artifacts WHERE task_id = $1 ORDER BY created_at ASC, id ASC`,
      [task.id],
    );
    const history = messages.rows.map((row) => this.messageView(task, row));
    const shown = historyLength === undefined ? history : history.slice(Math.max(0, history.length - historyLength));
    const latest = shown.at(-1);
    return {
      id: task.id,
      contextId: task.context_id,
      status: {
        state: task.state,
        timestamp: task.status_timestamp.toISOString(),
        ...(latest !== undefined ? { message: latest } : {}),
      },
      artifacts: artifacts.rows.map((row) => ({ artifactId: row.id, parts: row.parts })),
      history: shown,
      metadata: { [HANDOFF_EXTENSION]: task.metadata },
    };
  }

  private messageView(task: TaskRow, row: MessageRow): Record<string, unknown> {
    return {
      messageId: row.message_id,
      contextId: task.context_id,
      taskId: task.id,
      role: row.role,
      parts: row.parts,
    };
  }

  private async cardFor(client: PoolClient | Pool, agentId: string, ownerId: string): Promise<Record<string, unknown>> {
    const agent = await client.query<{ display_name: string; description: string }>(
      `SELECT display_name, description FROM agents WHERE id = $1 AND owner_id = $2`,
      [agentId, ownerId],
    );
    const profile = await client.query<{ availability: string; skills: Skill[] }>(
      `SELECT availability, skills FROM handoff_profiles WHERE agent_id = $1`,
      [agentId],
    );
    const row = agent.rows[0];
    const card = profile.rows[0];
    if (row === undefined || card === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const url = this.config.publicHostname === null
      ? '/api/v1/handoff/messages'
      : `https://${this.config.publicHostname}/api/v1/handoff/messages`;
    return {
      name: row.display_name,
      description: row.description === '' ? row.display_name : row.description,
      version: '0.1.0',
      supportedInterfaces: [{ protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', url }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: card.skills,
      availability: card.availability,
    };
  }

  private async activeAgent(client: PoolClient, agentId: string): Promise<{ id: string; owner_id: string } | null> {
    const result = await client.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM agents WHERE id = $1 AND status = 'active'`,
      [agentId],
    );
    return result.rows[0] ?? null;
  }

  private enabled(): void {
    if (!this.config.handoffEnabled) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
  }

  private async writer(accessToken: string, requestId: string): Promise<AgentPrincipal> {
    return this.identity.requireAgentScope({
      agentToken: accessToken,
      scope: 'handoff:write',
      claimedAgentId: undefined,
      requestId,
    });
  }

  private async reader(accessToken: string, requestId: string): Promise<AgentPrincipal> {
    const principal = await this.identity.authenticateAgent(accessToken);
    if (!principal.scopes.includes('handoff:read')) {
      await this.transaction(async (client) => {
        await this.audit(client, principal, 'handoff.read', 'denied', requestId, { scope: 'handoff:read', reason: 'scope' });
      });
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    return principal;
  }

  private async audit(
    client: PoolClient,
    principal: AgentPrincipal,
    action: string,
    result: 'success' | 'denied',
    requestId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (
         id, owner_id, agent_id, actor_kind, actor_id, action, result, request_id, detail
       ) VALUES ($1, $2, $3, 'agent', $3, $4, $5, $6, $7::jsonb)`,
      [
        uuidV7(this.now()),
        principal.ownerId,
        principal.agentId,
        action,
        result,
        requestId.length <= 200 ? requestId : null,
        JSON.stringify(auditDetail(detail)),
      ],
    );
  }

  private async beginIdempotent(
    client: PoolClient,
    ownerId: string,
    operation: string,
    idemKey: string,
    requestHash: string,
  ): Promise<Record<string, unknown> | null> {
    const inserted = await client.query(
      `INSERT INTO idempotency_records (owner_id, operation, idem_key, request_hash, response_json, status_code)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 0)
       ON CONFLICT (owner_id, operation, idem_key) DO NOTHING`,
      [ownerId, operation, idemKey, requestHash],
    );
    if (inserted.rowCount === 1) {
      return null;
    }
    const existing = await client.query<{ request_hash: string; response_json: Record<string, unknown>; status_code: number }>(
      `SELECT request_hash, response_json, status_code
       FROM idempotency_records
       WHERE owner_id = $1 AND operation = $2 AND idem_key = $3`,
      [ownerId, operation, idemKey],
    );
    const row = existing.rows[0];
    if (row === undefined || !sameDigest(row.request_hash, requestHash) || row.status_code === 0) {
      throw new IdentityError(409, 'Conflict', IDENTITY_DETAIL.idempotencyMismatch);
    }
    return row.response_json;
  }

  private async finishIdempotent(
    client: PoolClient,
    ownerId: string,
    operation: string,
    idemKey: string,
    body: object,
    statusCode: number,
  ): Promise<void> {
    await client.query(
      `UPDATE idempotency_records
       SET response_json = $4::jsonb, status_code = $5
       WHERE owner_id = $1 AND operation = $2 AND idem_key = $3`,
      [ownerId, operation, idemKey, JSON.stringify(body), statusCode],
    );
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
