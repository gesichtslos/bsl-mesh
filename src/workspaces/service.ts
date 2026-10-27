import type { Pool, PoolClient } from 'pg';

import type { AppConfig } from '../config.js';
import { auditDetail } from '../identity/audit.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { uuidV7 } from '../identity/ids.js';
import type { AgentPrincipal, IdentityService } from '../identity/service.js';
import { hashRequest, sameDigest } from '../identity/tokens.js';
import { workspaceDuties } from './duties.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANTS = ['read', 'contribute', 'administer'] as const;
type Grant = (typeof GRANTS)[number];

export class WorkspaceService {
  constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
    private readonly now: () => Date,
  ) {}

  async create(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    goal: unknown;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const goal = cleanGoal(input.goal);
    const requestHash = hashRequest({ goal });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'workspace.create', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const current = this.now();
      const id = uuidV7(current);
      await client.query(
        `INSERT INTO workspaces (id, goal, state, creator_agent_id, creator_owner_id, created_at, updated_at)
         VALUES ($1, $2, 'forming', $3, $4, $5, $5)`,
        [id, goal, principal.agentId, principal.ownerId, current],
      );
      await client.query(
        `INSERT INTO workspace_members (
           workspace_id, agent_id, owner_id, grant_name, status, created_at, updated_at
         ) VALUES ($1, $2, $3, 'administer', 'active', $4, $4)`,
        [id, principal.agentId, principal.ownerId, current],
      );
      await this.event(client, id, principal.agentId, 'created', principal.agentId, current);
      const body = await this.present(client, id, principal.agentId);
      await this.audit(client, principal, 'workspace.create', input.requestId, { task_id: id });
      await this.finishIdempotent(client, principal.ownerId, 'workspace.create', input.idempotencyKey, body, 201);
      return { statusCode: 201, body };
    });
  }

  async invite(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    workspaceId: string;
    agentId: string;
    grant: Grant;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ workspaceId: input.workspaceId, agentId: input.agentId, grant: input.grant });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'workspace.invite', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      await this.requireGrant(client, input.workspaceId, principal.agentId, 'administer');
      const agent = await client.query<{ owner_id: string }>(
        `SELECT owner_id FROM agents WHERE id = $1 AND status = 'active'`,
        [input.agentId],
      );
      const row = agent.rows[0];
      if (row === undefined || input.agentId === principal.agentId) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const current = this.now();
      await client.query(
        `INSERT INTO workspace_members (
           workspace_id, agent_id, owner_id, grant_name, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'invited', $5, $5)
         ON CONFLICT (workspace_id, agent_id) DO UPDATE
           SET grant_name = EXCLUDED.grant_name, status = 'invited', updated_at = EXCLUDED.updated_at
           WHERE workspace_members.status IN ('declined', 'removed', 'invited')`,
        [input.workspaceId, input.agentId, row.owner_id, input.grant, current],
      );
      await this.event(client, input.workspaceId, principal.agentId, 'invited', input.agentId, current);
      const body = { workspace_id: input.workspaceId, agent_id: input.agentId, grant: input.grant, status: 'invited' };
      await this.audit(client, principal, 'workspace.invite', input.requestId, { task_id: input.workspaceId, peer_agent_id: input.agentId });
      await this.finishIdempotent(client, principal.ownerId, 'workspace.invite', input.idempotencyKey, body, 201);
      return { statusCode: 201, body };
    });
  }

  async join(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    workspaceId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ workspaceId: input.workspaceId, action: 'join' });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'workspace.join', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const current = this.now();
      const updated = await client.query(
        `UPDATE workspace_members
         SET status = 'active', updated_at = $3
         WHERE workspace_id = $1 AND agent_id = $2 AND status = 'invited'`,
        [input.workspaceId, principal.agentId, current],
      );
      if ((updated.rowCount ?? 0) === 0) {
        const existing = await client.query(
          `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2 AND status = 'active'`,
          [input.workspaceId, principal.agentId],
        );
        if ((existing.rowCount ?? 0) === 0) {
          throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
        }
      } else {
        await client.query(
          `UPDATE workspaces SET state = 'active', updated_at = $2 WHERE id = $1 AND state = 'forming'`,
          [input.workspaceId, current],
        );
        await this.event(client, input.workspaceId, principal.agentId, 'joined', principal.agentId, current);
      }
      const body = await this.present(client, input.workspaceId, principal.agentId);
      await this.audit(client, principal, 'workspace.join', input.requestId, { task_id: input.workspaceId });
      await this.finishIdempotent(client, principal.ownerId, 'workspace.join', input.idempotencyKey, body, 200);
      return { statusCode: 200, body };
    });
  }

  async remove(input: {
    accessToken: string;
    idempotencyKey: string;
    requestId: string;
    workspaceId: string;
    agentId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    this.enabled();
    const principal = await this.writer(input.accessToken, input.requestId);
    const requestHash = hashRequest({ workspaceId: input.workspaceId, agentId: input.agentId, action: 'remove' });
    return this.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'workspace.remove', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      await this.requireGrant(client, input.workspaceId, principal.agentId, 'administer');
      const current = this.now();
      const updated = await client.query(
        `UPDATE workspace_members
         SET status = 'removed', updated_at = $3
         WHERE workspace_id = $1 AND agent_id = $2 AND status IN ('invited', 'active')`,
        [input.workspaceId, input.agentId, current],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      await this.event(client, input.workspaceId, principal.agentId, 'removed', input.agentId, current);
      const body = { workspace_id: input.workspaceId, agent_id: input.agentId, status: 'removed' };
      await this.audit(client, principal, 'workspace.remove', input.requestId, { task_id: input.workspaceId, peer_agent_id: input.agentId });
      await this.finishIdempotent(client, principal.ownerId, 'workspace.remove', input.idempotencyKey, body, 200);
      return { statusCode: 200, body };
    });
  }

  async get(accessToken: string, workspaceId: string): Promise<Record<string, unknown>> {
    this.enabled();
    if (!UUID.test(workspaceId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const principal = await this.reader(accessToken);
    return this.present(this.pool, workspaceId, principal.agentId);
  }

  private async present(client: PoolClient | Pool, workspaceId: string, agentId: string): Promise<Record<string, unknown>> {
    const workspace = await client.query<{ id: string; goal: string; state: string }>(
      `SELECT id, goal, state FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const row = workspace.rows[0];
    const member = await client.query<{ grant_name: Grant; status: string }>(
      `SELECT grant_name, status FROM workspace_members WHERE workspace_id = $1 AND agent_id = $2`,
      [workspaceId, agentId],
    );
    const self = member.rows[0];
    if (row === undefined || self === undefined || self.status === 'removed' || self.status === 'declined') {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    if (self.status === 'invited') {
      return { id: row.id, goal: row.goal, state: row.state, membership: { status: 'invited', grant: self.grant_name } };
    }
    const members = await client.query<{ agent_id: string; owner_id: string; grant_name: string; status: string }>(
      `SELECT agent_id, owner_id, grant_name, status
       FROM workspace_members
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY created_at, agent_id`,
      [workspaceId],
    );
    const events = await client.query<{ action: string; actor_agent_id: string; subject_agent_id: string | null; created_at: Date }>(
      `SELECT action, actor_agent_id, subject_agent_id, created_at
       FROM workspace_events
       WHERE workspace_id = $1
       ORDER BY created_at, id`,
      [workspaceId],
    );
    return {
      id: row.id,
      goal: row.goal,
      state: row.state,
      membership: { status: self.status, grant: self.grant_name },
      members: members.rows,
      events: events.rows.map((event) => ({
        action: event.action,
        actor_agent_id: event.actor_agent_id,
        subject_agent_id: event.subject_agent_id,
        created_at: event.created_at.toISOString(),
      })),
      duties: workspaceDuties(row.id),
    };
  }

  private async requireGrant(client: PoolClient, workspaceId: string, agentId: string, grant: Grant): Promise<void> {
    const result = await client.query<{ grant_name: Grant; state: string }>(
      `SELECT member.grant_name, workspace.state
       FROM workspace_members AS member
       JOIN workspaces AS workspace ON workspace.id = member.workspace_id
       WHERE member.workspace_id = $1 AND member.agent_id = $2 AND member.status = 'active'`,
      [workspaceId, agentId],
    );
    const row = result.rows[0];
    if (row === undefined || row.state === 'archived' || row.state === 'closing') {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    if (grant === 'administer' && row.grant_name !== 'administer') {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
  }

  private async event(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
    action: 'created' | 'invited' | 'joined' | 'removed' | 'archived',
    subjectId: string,
    current: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO workspace_events (id, workspace_id, actor_agent_id, action, subject_agent_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidV7(current), workspaceId, actorId, action, subjectId, current],
    );
  }

  private enabled(): void {
    if (!this.config.handoffEnabled) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
  }

  private async writer(accessToken: string, requestId: string): Promise<AgentPrincipal> {
    return this.identity.requireAgentScope({
      agentToken: accessToken,
      scope: 'workspaces:write',
      claimedAgentId: undefined,
      requestId,
    });
  }

  private async reader(accessToken: string): Promise<AgentPrincipal> {
    const principal = await this.identity.authenticateAgent(accessToken);
    if (!principal.scopes.includes('workspaces:read')) {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    return principal;
  }

  private async audit(
    client: PoolClient,
    principal: AgentPrincipal,
    action: string,
    requestId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (
         id, owner_id, agent_id, actor_kind, actor_id, action, result, request_id, detail
       ) VALUES ($1, $2, $3, 'agent', $3, $4, 'success', $5, $6::jsonb)`,
      [uuidV7(this.now()), principal.ownerId, principal.agentId, action, requestId.length <= 200 ? requestId : null, JSON.stringify(auditDetail(detail))],
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
      `SELECT request_hash, response_json, status_code FROM idempotency_records
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
      `UPDATE idempotency_records SET response_json = $4::jsonb, status_code = $5
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

function cleanGoal(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 2000) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return value;
}

export function parseGrant(value: unknown): Grant {
  if (typeof value !== 'string' || !(GRANTS as readonly string[]).includes(value)) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return value as Grant;
}
