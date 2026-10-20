import type { Pool, PoolClient } from 'pg';

import type { AppConfig } from '../config.js';
import { auditDetail, type AuditDetail, type AuditReason } from './audit.js';
import { IDENTITY_DETAIL, IdentityError } from './errors.js';
import { uuidV7 } from './ids.js';
import { createOneTimeCodeDelivery } from './provider.js';
import { consumeRateLimit, MAGIC_LINK_EMAIL_LIMIT, type RatePrincipal } from './rate-limit.js';
import { isScope, isWriteScope, resolveScopes, type Scope, type WriteScope } from './scopes.js';
import {
  expectedTokenPrefix,
  generateToken,
  hashRequest,
  hashToken,
  sameDigest,
} from './tokens.js';
import { parseDescription, parseDisplayName, parseEmail, parseTtlSeconds } from './validate.js';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Queryable = Pick<Pool | PoolClient, 'query'>;

type OwnerRecord = {
  id: string;
  displayName: string;
  email: string;
  status: 'active' | 'disabled';
  publicationEnabled: boolean;
};

export type AgentPrincipal = {
  credentialId: string;
  agentId: string;
  ownerId: string;
  scopes: Scope[];
  publicationEnabled: boolean;
  expiresAt: Date;
};

type CredentialRecord = {
  id: string;
  agentId: string;
  scopes: Scope[];
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ApiResult<T> = {
  statusCode: number;
  body: T;
};

export type CredentialBody = {
  id: string;
  agent_id: string;
  scopes: Scope[];
  expires_at: string;
  secret_available: boolean;
  token?: string;
};

export class IdentityService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueTestMagicLink(input: { email: string; displayName: string }): Promise<{
    expires_at: string;
    magic_link_token: string;
  }> {
    const delivery = createOneTimeCodeDelivery(this.config);
    if (delivery.mode !== 'test') {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.registrationDisabled);
    }
    const email = parseEmail(input.email);
    const displayName = parseDisplayName(input.displayName);
    await this.limit([{ kind: 'anonymous', id: `magic:${hashToken(email)}`, limit: MAGIC_LINK_EMAIL_LIMIT }]);
    const token = generateToken('magic');
    const expiresAt = new Date(this.now().getTime() + MAGIC_LINK_TTL_MS);
    await this.withTransaction(async (client) => {
      await client.query(
        `UPDATE magic_links
         SET consumed_at = $2
         WHERE email = $1 AND consumed_at IS NULL`,
        [email, this.now()],
      );
      const issuedAt = this.now();
      await client.query(
        `INSERT INTO magic_links (id, email, display_name, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidV7(issuedAt), email, displayName, hashToken(token), expiresAt, issuedAt],
      );
      await delivery.deliver({ email, code: token, expiresAt });
    });
    return { expires_at: expiresAt.toISOString(), magic_link_token: token };
  }

  async consumeMagicLink(input: { token: string; requestId: string }): Promise<{
    session_token: string;
    expires_at: string;
    owner_id: string;
  }> {
    const delivery = createOneTimeCodeDelivery(this.config);
    if (delivery.mode !== 'test') {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.registrationDisabled);
    }
    this.assertPresentedToken(input.token, 'magic');
    const current = this.now();
    const issued = await this.withTransaction(async (client) => {
      const link = await client.query<{ email: string; display_name: string }>(
        `UPDATE magic_links
         SET consumed_at = $2
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
         RETURNING email, display_name`,
        [hashToken(input.token), current],
      );
      const consumed = link.rows[0];
      if (consumed === undefined) {
        throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
      }
      const owner = await this.upsertOwner(client, consumed.email, consumed.display_name, current);
      if (owner.status !== 'active') {
        return null;
      }
      const sessionToken = generateToken('owner');
      const sessionId = uuidV7(current);
      const expiresAt = new Date(current.getTime() + OWNER_SESSION_TTL_MS);
      await client.query(
        `INSERT INTO owner_sessions (id, owner_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, owner.id, hashToken(sessionToken), expiresAt, current],
      );
      await this.audit(client, {
        ownerId: owner.id,
        agentId: null,
        actorKind: 'owner',
        actorId: owner.id,
        action: 'owner.session_issued',
        result: 'success',
        requestId: input.requestId,
        detail: {},
      });
      return { sessionToken, expiresAt, ownerId: owner.id };
    });
    if (issued === null) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
    return {
      session_token: issued.sessionToken,
      expires_at: issued.expiresAt.toISOString(),
      owner_id: issued.ownerId,
    };
  }

  async getOwner(sessionToken: string): Promise<{
    id: string;
    display_name: string;
    email: string;
    status: 'active' | 'disabled';
    publication_enabled: boolean;
  }> {
    const owner = await this.ownerFromToken(sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return {
      id: owner.id,
      display_name: owner.displayName,
      email: owner.email,
      status: owner.status,
      publication_enabled: owner.publicationEnabled,
    };
  }

  async createAgent(input: {
    sessionToken: string;
    idempotencyKey: string;
    displayName: string;
    description: string | undefined;
    requestId: string;
  }): Promise<ApiResult<Record<string, unknown>>> {
    const displayName = parseDisplayName(input.displayName);
    const description = parseDescription(input.description);
    const requestHash = hashRequest({ displayName, description });
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, owner.id, 'agent.create', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return { statusCode: 201, body: replay };
      }
      const current = this.now();
      const id = uuidV7(current);
      await client.query(
        `INSERT INTO agents (id, owner_id, display_name, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
        [id, owner.id, displayName, description, current],
      );
      const body = {
        id,
        owner_id: owner.id,
        display_name: displayName,
        description,
        status: 'active',
        created_at: current.toISOString(),
      };
      await this.audit(client, {
        ownerId: owner.id,
        agentId: id,
        actorKind: 'owner',
        actorId: owner.id,
        action: 'agent.registered',
        result: 'success',
        requestId: input.requestId,
        detail: { agent_id: id },
      });
      await this.finishIdempotent(client, owner.id, 'agent.create', input.idempotencyKey, body);
      return { statusCode: 201, body };
    });
  }

  async listAgents(sessionToken: string): Promise<{ items: Record<string, unknown>[] }> {
    const owner = await this.ownerFromToken(sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      description: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, display_name, description, status, created_at
       FROM agents
       WHERE owner_id = $1
       ORDER BY created_at ASC, id ASC`,
      [owner.id],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        owner_id: owner.id,
        display_name: row.display_name,
        description: row.description,
        status: row.status,
        created_at: row.created_at.toISOString(),
      })),
    };
  }

  async getAgent(sessionToken: string, agentId: string): Promise<Record<string, unknown>> {
    if (!UUID.test(agentId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const owner = await this.ownerFromToken(sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      description: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, display_name, description, status, created_at
       FROM agents
       WHERE id = $1 AND owner_id = $2`,
      [agentId, owner.id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return {
      id: row.id,
      owner_id: owner.id,
      display_name: row.display_name,
      description: row.description,
      status: row.status,
      created_at: row.created_at.toISOString(),
    };
  }

  async createCredential(input: {
    sessionToken: string;
    idempotencyKey: string;
    agentId: string;
    scopes: readonly string[] | undefined;
    ttlSeconds: number;
    requestId: string;
  }): Promise<ApiResult<CredentialBody>> {
    const scopes = resolveScopes(input.scopes);
    const ttlSeconds = parseTtlSeconds(input.ttlSeconds);
    if (!UUID.test(input.agentId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const requestHash = hashRequest({ agentId: input.agentId, scopes, ttlSeconds });
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(
        client,
        owner.id,
        'credential.create',
        input.idempotencyKey,
        requestHash,
      );
      if (replay !== null) {
        return { statusCode: 201, body: replay as CredentialBody };
      }
      await this.requireOwnAgent(client, owner.id, input.agentId);
      const current = this.now();
      const id = uuidV7(current);
      const token = generateToken('agent');
      const expiresAt = new Date(current.getTime() + ttlSeconds * 1000);
      await client.query(
        `INSERT INTO credentials (id, owner_id, agent_id, token_hash, scopes, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, owner.id, input.agentId, hashToken(token), scopes, expiresAt, current],
      );
      const persisted: CredentialBody = {
        id,
        agent_id: input.agentId,
        scopes,
        expires_at: expiresAt.toISOString(),
        secret_available: false,
      };
      await this.audit(client, {
        ownerId: owner.id,
        agentId: input.agentId,
        actorKind: 'owner',
        actorId: owner.id,
        action: 'credential.issued',
        result: 'success',
        requestId: input.requestId,
        detail: { agent_id: input.agentId, credential_id: id, scopes },
      });
      await this.finishIdempotent(client, owner.id, 'credential.create', input.idempotencyKey, persisted);
      return { statusCode: 201, body: { ...persisted, secret_available: true, token } };
    });
  }

  async listCredentials(sessionToken: string): Promise<{ items: Record<string, unknown>[] }> {
    const owner = await this.ownerFromToken(sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      scopes: string[];
      expires_at: Date;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, agent_id, scopes, expires_at, revoked_at, created_at
       FROM credentials
       WHERE owner_id = $1
       ORDER BY created_at ASC, id ASC`,
      [owner.id],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        scopes: row.scopes,
        expires_at: row.expires_at.toISOString(),
        revoked_at: row.revoked_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      })),
    };
  }

  async revokeCredential(input: {
    sessionToken: string;
    idempotencyKey: string;
    credentialId: string;
    requestId: string;
  }): Promise<ApiResult<Record<string, unknown>>> {
    if (!UUID.test(input.credentialId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const requestHash = hashRequest({ credentialId: input.credentialId });
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(
        client,
        owner.id,
        'credential.revoke',
        input.idempotencyKey,
        requestHash,
      );
      if (replay !== null) {
        return { statusCode: 200, body: replay };
      }
      const existing = await this.ownCredential(client, owner.id, input.credentialId);
      if (existing === null) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const revokedAt = existing.revokedAt ?? this.now();
      if (existing.revokedAt === null) {
        await client.query(
          `UPDATE credentials
           SET revoked_at = $3
           WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL`,
          [existing.id, owner.id, revokedAt],
        );
        await this.audit(client, {
          ownerId: owner.id,
          agentId: existing.agentId,
          actorKind: 'owner',
          actorId: owner.id,
          action: 'credential.revoked',
          result: 'success',
          requestId: input.requestId,
          detail: { agent_id: existing.agentId, credential_id: existing.id },
        });
      }
      const body = {
        id: existing.id,
        agent_id: existing.agentId,
        revoked_at: revokedAt.toISOString(),
      };
      await this.finishIdempotent(client, owner.id, 'credential.revoke', input.idempotencyKey, body, 200);
      return { statusCode: 200, body };
    });
  }

  async rotateCredential(input: {
    sessionToken: string;
    idempotencyKey: string;
    credentialId: string;
    ttlSeconds: number;
    requestId: string;
  }): Promise<ApiResult<CredentialBody>> {
    if (!UUID.test(input.credentialId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const ttlSeconds = parseTtlSeconds(input.ttlSeconds);
    const requestHash = hashRequest({ credentialId: input.credentialId, ttlSeconds });
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(
        client,
        owner.id,
        'credential.rotate',
        input.idempotencyKey,
        requestHash,
      );
      if (replay !== null) {
        return { statusCode: 201, body: replay as CredentialBody };
      }
      const existing = await this.ownCredential(client, owner.id, input.credentialId);
      if (existing === null) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const current = this.now();
      if (existing.revokedAt !== null || existing.expiresAt.getTime() <= current.getTime()) {
        throw new IdentityError(409, 'Conflict', IDENTITY_DETAIL.credentialClosed);
      }
      const nextId = uuidV7(current);
      const token = generateToken('agent');
      const expiresAt = new Date(current.getTime() + ttlSeconds * 1000);
      await client.query(
        `UPDATE credentials SET revoked_at = $3 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL`,
        [existing.id, owner.id, current],
      );
      await client.query(
        `INSERT INTO credentials (
           id, owner_id, agent_id, token_hash, scopes, expires_at, rotated_from_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [nextId, owner.id, existing.agentId, hashToken(token), existing.scopes, expiresAt, existing.id, current],
      );
      const persisted: CredentialBody = {
        id: nextId,
        agent_id: existing.agentId,
        scopes: existing.scopes,
        expires_at: expiresAt.toISOString(),
        secret_available: false,
      };
      await this.audit(client, {
        ownerId: owner.id,
        agentId: existing.agentId,
        actorKind: 'owner',
        actorId: owner.id,
        action: 'credential.revoked',
        result: 'success',
        requestId: input.requestId,
        detail: { agent_id: existing.agentId, credential_id: existing.id },
      });
      await this.audit(client, {
        ownerId: owner.id,
        agentId: existing.agentId,
        actorKind: 'owner',
        actorId: owner.id,
        action: 'credential.rotated',
        result: 'success',
        requestId: input.requestId,
        detail: {
          agent_id: existing.agentId,
          credential_id: nextId,
          rotated_from_id: existing.id,
          scopes: existing.scopes,
        },
      });
      await this.finishIdempotent(client, owner.id, 'credential.rotate', input.idempotencyKey, persisted);
      return { statusCode: 201, body: { ...persisted, secret_available: true, token } };
    });
  }

  async setPublication(input: {
    sessionToken: string;
    idempotencyKey: string;
    enabled: boolean;
    requestId: string;
  }): Promise<ApiResult<{ publication_enabled: boolean }>> {
    const requestHash = hashRequest({ enabled: input.enabled });
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(
        client,
        owner.id,
        'publication.set',
        input.idempotencyKey,
        requestHash,
      );
      if (replay !== null) {
        return { statusCode: 200, body: replay as { publication_enabled: boolean } };
      }
      const current = this.now();
      await client.query(
        `UPDATE owners SET publication_enabled = $2, updated_at = $3 WHERE id = $1`,
        [owner.id, input.enabled, current],
      );
      const body = { publication_enabled: input.enabled };
      await this.audit(client, {
        ownerId: owner.id,
        agentId: null,
        actorKind: 'owner',
        actorId: owner.id,
        action: input.enabled ? 'publication.enabled' : 'publication.disabled',
        result: 'success',
        requestId: input.requestId,
        detail: { publication_enabled: input.enabled },
      });
      await this.finishIdempotent(client, owner.id, 'publication.set', input.idempotencyKey, body, 200);
      return { statusCode: 200, body };
    });
  }

  async listAudit(input: {
    sessionToken: string;
    limit: number;
    cursor: string | undefined;
  }): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const owner = await this.ownerFromToken(input.sessionToken);
    await this.limit([{ kind: 'owner', id: owner.id, limit: this.config.rateLimitOwnerPerMinute }]);
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const result = await this.pool.query<{
      id: string;
      agent_id: string | null;
      actor_kind: string;
      actor_id: string;
      action: string;
      result: string;
      request_id: string | null;
      detail: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, agent_id, actor_kind, actor_id, action, result, request_id, detail, created_at
       FROM audit_events
       WHERE owner_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [owner.id, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
    );
    const page = result.rows.slice(0, input.limit);
    const last = page.at(-1);
    const next = result.rows.length > input.limit && last !== undefined
      ? encodeCursor(last.created_at, last.id)
      : null;
    return {
      items: page.map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        actor_kind: row.actor_kind,
        actor_id: row.actor_id,
        action: row.action,
        result: row.result,
        request_id: row.request_id,
        detail: auditDetail(row.detail ?? {}),
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: next,
    };
  }

  async getAgentProfile(agentToken: string): Promise<Record<string, unknown>> {
    const principal = await this.agentFromToken(agentToken);
    await this.limit(this.agentLimits(principal));
    if (!principal.scopes.includes('profile:read')) {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    const agent = await this.pool.query<{ display_name: string; status: string }>(
      `SELECT display_name, status FROM agents WHERE id = $1 AND owner_id = $2`,
      [principal.agentId, principal.ownerId],
    );
    const row = agent.rows[0];
    if (row === undefined) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
    return {
      agent_id: principal.agentId,
      owner_id: principal.ownerId,
      display_name: row.display_name,
      status: row.status,
      scopes: principal.scopes,
      publication_enabled: principal.publicationEnabled,
      credential_id: principal.credentialId,
      expires_at: principal.expiresAt.toISOString(),
    };
  }

  async authenticateAgent(agentToken: string, options?: { rateLimit?: boolean }): Promise<AgentPrincipal> {
    const principal = await this.agentFromToken(agentToken);
    if (options?.rateLimit !== false) {
      await this.limit(this.agentLimits(principal));
    }
    return principal;
  }

  async authenticateScopedAgent(agentToken: string, scope: WriteScope, requestId: string): Promise<AgentPrincipal> {
    const principal = await this.agentFromToken(agentToken);
    await this.limit(this.agentLimits(principal));
    if (!principal.scopes.includes(scope)) {
      await this.recordDenial(principal, scope, 'scope', undefined, requestId);
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    return principal;
  }

  async requireAgentScope(input: {
    agentToken: string;
    scope: string;
    claimedAgentId: string | undefined;
    requestId: string;
  }): Promise<AgentPrincipal> {
    const principal = await this.agentFromToken(input.agentToken);
    await this.limit(this.agentLimits(principal));
    if (!isWriteScope(input.scope)) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    if (input.claimedAgentId !== undefined && input.claimedAgentId !== principal.agentId) {
      await this.recordDenial(principal, input.scope, 'impersonation', input.claimedAgentId, input.requestId);
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.impersonation);
    }
    if (!principal.publicationEnabled) {
      await this.recordDenial(principal, input.scope, 'publication', undefined, input.requestId);
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.publicationDisabled);
    }
    if (!principal.scopes.includes(input.scope)) {
      await this.recordDenial(principal, input.scope, 'scope', undefined, input.requestId);
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    return principal;
  }

  async authorizeWrite(input: {
    agentToken: string;
    scope: string;
    claimedAgentId: string | undefined;
    requestId: string;
  }): Promise<void> {
    await this.requireAgentScope(input);
  }

  private agentLimits(principal: AgentPrincipal): RatePrincipal[] {
    return [
      { kind: 'agent', id: principal.agentId, limit: this.config.rateLimitAgentPerMinute },
      { kind: 'owner', id: principal.ownerId, limit: this.config.rateLimitOwnerPerMinute },
    ];
  }

  private async limit(principals: readonly RatePrincipal[]): Promise<void> {
    await consumeRateLimit(this.pool, principals, this.now());
  }

  private async ownerFromToken(token: string): Promise<OwnerRecord> {
    this.assertPresentedToken(token, 'owner');
    const result = await this.pool.query<{
      owner_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      status: string;
      publication_enabled: boolean;
      display_name: string;
      email: string;
    }>(
      `SELECT s.owner_id, s.expires_at, s.revoked_at, o.status, o.publication_enabled, o.display_name, o.email
       FROM owner_sessions AS s
       JOIN owners AS o ON o.id = s.owner_id
       WHERE s.token_hash = $1`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (
      row === undefined
      || row.revoked_at !== null
      || row.expires_at.getTime() <= this.now().getTime()
      || row.status !== 'active'
    ) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
    return {
      id: row.owner_id,
      displayName: row.display_name,
      email: row.email,
      status: 'active',
      publicationEnabled: row.publication_enabled,
    };
  }

  private async agentFromToken(token: string): Promise<AgentPrincipal> {
    this.assertPresentedToken(token, 'agent');
    const result = await this.pool.query<{
      id: string;
      owner_id: string;
      agent_id: string;
      scopes: string[];
      expires_at: Date;
      revoked_at: Date | null;
      agent_status: string;
      owner_status: string;
      publication_enabled: boolean;
    }>(
      `SELECT c.id, c.owner_id, c.agent_id, c.scopes, c.expires_at, c.revoked_at,
              a.status AS agent_status, o.status AS owner_status, o.publication_enabled
       FROM credentials AS c
       JOIN agents AS a ON a.id = c.agent_id AND a.owner_id = c.owner_id
       JOIN owners AS o ON o.id = c.owner_id
       WHERE c.token_hash = $1`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (
      row === undefined
      || row.revoked_at !== null
      || row.expires_at.getTime() <= this.now().getTime()
      || row.agent_status !== 'active'
      || row.owner_status !== 'active'
      || !row.scopes.every((item) => isScope(item))
    ) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
    return {
      credentialId: row.id,
      agentId: row.agent_id,
      ownerId: row.owner_id,
      scopes: row.scopes.filter((item): item is Scope => isScope(item)),
      publicationEnabled: row.publication_enabled,
      expiresAt: row.expires_at,
    };
  }

  private assertPresentedToken(token: string, kind: 'owner' | 'agent' | 'magic'): void {
    if (
      token.length < 40
      || token.length > 200
      || !token.startsWith(expectedTokenPrefix(kind))
    ) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
  }

  private async upsertOwner(client: PoolClient, email: string, displayName: string, current: Date): Promise<OwnerRecord> {
    const inserted = await client.query<{
      id: string;
      display_name: string;
      email: string;
      status: string;
      publication_enabled: boolean;
    }>(
      `INSERT INTO owners (id, display_name, email, email_verified_at, status, publication_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', true, $4, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, display_name, email, status, publication_enabled`,
      [uuidV7(current), displayName, email, current],
    );
    const created = inserted.rows[0];
    if (created !== undefined && created.status === 'active') {
      return {
        id: created.id,
        displayName: created.display_name,
        email: created.email,
        status: 'active',
        publicationEnabled: created.publication_enabled,
      };
    }
    if (created !== undefined) {
      return {
        id: created.id,
        displayName: created.display_name,
        email: created.email,
        status: 'disabled',
        publicationEnabled: created.publication_enabled,
      };
    }
    const existing = await client.query<{
      id: string;
      display_name: string;
      email: string;
      status: string;
      publication_enabled: boolean;
    }>(
      `SELECT id, display_name, email, status, publication_enabled FROM owners WHERE email = $1`,
      [email],
    );
    const row = existing.rows[0];
    if (row === undefined || (row.status !== 'active' && row.status !== 'disabled')) {
      throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
    }
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      status: row.status,
      publicationEnabled: row.publication_enabled,
    };
  }

  private async requireOwnAgent(client: Queryable, ownerId: string, agentId: string): Promise<void> {
    const result = await client.query(
      `SELECT id FROM agents WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
      [agentId, ownerId],
    );
    if (result.rows[0] === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
  }

  private async ownCredential(client: Queryable, ownerId: string, credentialId: string): Promise<CredentialRecord | null> {
    const result = await client.query<{
      id: string;
      agent_id: string;
      scopes: string[];
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, agent_id, scopes, expires_at, revoked_at
       FROM credentials
       WHERE id = $1 AND owner_id = $2`,
      [credentialId, ownerId],
    );
    const row = result.rows[0];
    if (row === undefined || !row.scopes.every((item) => isScope(item))) {
      return null;
    }
    return {
      id: row.id,
      agentId: row.agent_id,
      scopes: row.scopes.filter((item): item is Scope => isScope(item)),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  private async recordDenial(
    principal: AgentPrincipal,
    scope: WriteScope,
    reason: AuditReason,
    claimedAgentId: string | undefined,
    requestId: string,
  ): Promise<void> {
    const detail: AuditDetail = { agent_id: principal.agentId, scope, reason };
    if (claimedAgentId !== undefined) {
      detail.claimed_agent_id = claimedAgentId;
    }
    await this.withTransaction(async (client) => {
      await this.audit(client, {
        ownerId: principal.ownerId,
        agentId: principal.agentId,
        actorKind: 'agent',
        actorId: principal.agentId,
        action: 'access.denied',
        result: 'denied',
        requestId,
        detail,
      });
    });
  }

  private async audit(
    client: Queryable,
    event: {
      ownerId: string;
      agentId: string | null;
      actorKind: 'owner' | 'agent' | 'system';
      actorId: string;
      action: string;
      result: 'success' | 'denied';
      requestId: string;
      detail: AuditDetail;
    },
  ): Promise<void> {
    const requestId = event.requestId.length <= 200 ? event.requestId : null;
    await client.query(
      `INSERT INTO audit_events (
         id, owner_id, agent_id, actor_kind, actor_id, action, result, request_id, detail
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        uuidV7(this.now()),
        event.ownerId,
        event.agentId,
        event.actorKind,
        event.actorId,
        event.action,
        event.result,
        requestId,
        JSON.stringify(auditDetail({ ...event.detail })),
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
    statusCode = 201,
  ): Promise<void> {
    await client.query(
      `UPDATE idempotency_records
       SET response_json = $4::jsonb, status_code = $5
       WHERE owner_id = $1 AND operation = $2 AND idem_key = $3`,
      [ownerId, operation, idemKey, JSON.stringify(body), statusCode],
    );
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
    }
    const record = parsed as { t?: unknown; i?: unknown };
    if (typeof record.t !== 'string' || typeof record.i !== 'string' || !UUID.test(record.i)) {
      throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
    }
    const time = new Date(record.t);
    if (Number.isNaN(time.getTime())) {
      throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
    }
    return { createdAt: time.toISOString(), id: record.i };
  } catch (error) {
    if (error instanceof IdentityError) {
      throw error;
    }
    throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
  }
}
