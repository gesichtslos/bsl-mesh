import type { Pool, PoolClient } from 'pg';

import { auditDetail } from '../identity/audit.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { uuidV7 } from '../identity/ids.js';
import type { IdentityService } from '../identity/service.js';
import { hashRequest, sameDigest } from '../identity/tokens.js';
import { parseTelemetryReport } from './schema.js';

export class TelemetryService {
  constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submit(input: {
    accessToken: string;
    idempotencyKey: string;
    report: unknown;
    requestId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.identity.authenticateScopedAgent(input.accessToken, 'telemetry:write', input.requestId);
    const document = parseTelemetryReport(input.report);
    if (input.idempotencyKey !== document['report_id']) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const requestHash = hashRequest(document);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO idempotency_records (owner_id, operation, idem_key, request_hash, response_json, status_code)
         VALUES ($1, 'telemetry.submit', $2, $3, '{}'::jsonb, 0)
         ON CONFLICT (owner_id, operation, idem_key) DO NOTHING`,
        [principal.ownerId, input.idempotencyKey, requestHash],
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ request_hash: string; response_json: Record<string, unknown>; status_code: number }>(
          `SELECT request_hash, response_json, status_code
           FROM idempotency_records
           WHERE owner_id = $1 AND operation = 'telemetry.submit' AND idem_key = $2`,
          [principal.ownerId, input.idempotencyKey],
        );
        const row = existing.rows[0];
        if (row === undefined || !sameDigest(row.request_hash, requestHash) || row.status_code === 0) {
          throw new IdentityError(409, 'Conflict', IDENTITY_DETAIL.idempotencyMismatch);
        }
        await client.query('COMMIT');
        return { statusCode: row.status_code, body: row.response_json };
      }
      const body = {
        report: document,
        acceptance: 'stored_unverified',
        independent_owner_confirmations: 0,
        agent_id: principal.agentId,
        created_at: this.now().toISOString(),
      };
      await client.query(
        `INSERT INTO telemetry_reports (
           owner_id, agent_id, report_id, source_kind, schema_version, document, acceptance, created_at
         ) VALUES ($1, $2, $3, $4, '1', $5::jsonb, 'stored_unverified', $6)`,
        [
          principal.ownerId,
          principal.agentId,
          document['report_id'],
          document['source_kind'],
          JSON.stringify(document),
          body.created_at,
        ],
      );
      await this.audit(client, principal.ownerId, principal.agentId, input.requestId, {
        report_id: document['report_id'],
        source_kind: document['source_kind'],
      });
      await client.query(
        `UPDATE idempotency_records
         SET response_json = $4::jsonb, status_code = 201
         WHERE owner_id = $1 AND operation = 'telemetry.submit' AND idem_key = $2 AND request_hash = $3`,
        [principal.ownerId, input.idempotencyKey, requestHash, JSON.stringify(body)],
      );
      await client.query('COMMIT');
      return { statusCode: 201, body };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(input: {
    accessToken: string;
    sourceKind: 'organic' | 'synthetic' | null;
  }): Promise<{ items: Array<Record<string, unknown>> }> {
    const ownerId = await this.ownerId(input.accessToken);
    const result = await this.pool.query<{
      report_id: string;
      source_kind: string;
      created_at: Date;
      outcome: string;
    }>(
      `SELECT report_id, source_kind, created_at, document->'task'->>'outcome' AS outcome
       FROM telemetry_reports
       WHERE owner_id = $1 AND ($2::text IS NULL OR source_kind = $2)
       ORDER BY created_at ASC, report_id ASC`,
      [ownerId, input.sourceKind],
    );
    return {
      items: result.rows.map((row) => ({
        report_id: row.report_id,
        source_kind: row.source_kind,
        outcome: row.outcome,
        acceptance: 'stored_unverified',
        independent_owner_confirmations: 0,
        created_at: row.created_at.toISOString(),
      })),
    };
  }

  async get(accessToken: string, reportId: string): Promise<Record<string, unknown>> {
    const ownerId = await this.ownerId(accessToken);
    const result = await this.pool.query<{ response_json: Record<string, unknown> }>(
      `SELECT response_json
       FROM idempotency_records
       WHERE owner_id = $1 AND operation = 'telemetry.submit' AND idem_key = $2 AND status_code = 201`,
      [ownerId, reportId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return row.response_json;
  }

  private async ownerId(accessToken: string): Promise<string> {
    if (accessToken.startsWith('bslm_own_')) {
      const owner = await this.identity.getOwner(accessToken);
      return owner.id;
    }
    const principal = await this.identity.authenticateScopedAgent(accessToken, 'telemetry:write', 'telemetry.read');
    return principal.ownerId;
  }

  private async audit(
    client: PoolClient,
    ownerId: string,
    agentId: string,
    requestId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (
         id, owner_id, agent_id, actor_kind, actor_id, action, result, request_id, detail
       ) VALUES ($1, $2, $3, 'agent', $4, 'telemetry.report_stored', 'success', $5, $6::jsonb)`,
      [uuidV7(this.now()), ownerId, agentId, agentId, requestId.length <= 200 ? requestId : null, JSON.stringify(auditDetail(detail))],
    );
  }
}
