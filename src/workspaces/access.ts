import type { Pool, PoolClient } from 'pg';

import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function assertWorkspaceSend(
  client: Queryable,
  contextId: string,
  senderAgentId: string,
  recipientAgentId: string,
): Promise<boolean> {
  const workspace = await client.query<{ state: string }>(
    `SELECT state FROM workspaces WHERE id = $1`,
    [contextId],
  );
  const row = workspace.rows[0];
  if (row === undefined) {
    return false;
  }
  if (row.state !== 'active') {
    throw new IdentityError(409, 'Conflict', 'The workspace is not accepting tasks.');
  }
  const members = await client.query<{ agent_id: string; grant_name: string }>(
    `SELECT agent_id, grant_name
     FROM workspace_members
     WHERE workspace_id = $1 AND status = 'active' AND agent_id IN ($2, $3)`,
    [contextId, senderAgentId, recipientAgentId],
  );
  const sender = members.rows.find((item) => item.agent_id === senderAgentId);
  const recipient = members.rows.find((item) => item.agent_id === recipientAgentId);
  if (sender === undefined || recipient === undefined) {
    throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
  }
  if (sender.grant_name === 'read') {
    throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
  }
  return true;
}

export async function assertWorkspaceRead(client: Queryable, contextId: string, agentId: string): Promise<void> {
  const workspace = await client.query<{ state: string }>(
    `SELECT state FROM workspaces WHERE id = $1`,
    [contextId],
  );
  if (workspace.rows[0] === undefined) {
    return;
  }
  const member = await client.query(
    `SELECT 1 FROM workspace_members
     WHERE workspace_id = $1 AND agent_id = $2 AND status = 'active'`,
    [contextId, agentId],
  );
  if ((member.rowCount ?? 0) === 0) {
    throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
  }
}

export const WORKSPACE_TASK_FILTER = `AND NOT EXISTS (
  SELECT 1 FROM workspaces AS workspace_boundary
  WHERE workspace_boundary.id = handoff_tasks.context_id
    AND NOT EXISTS (
      SELECT 1 FROM workspace_members AS workspace_member
      WHERE workspace_member.workspace_id = workspace_boundary.id
        AND workspace_member.agent_id = $1
        AND workspace_member.status = 'active'
    )
)`;
