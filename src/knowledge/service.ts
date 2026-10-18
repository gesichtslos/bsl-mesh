import type { Pool, PoolClient } from 'pg';

import type { AppConfig } from '../config.js';
import { auditDetail } from '../identity/audit.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { uuidV7 } from '../identity/ids.js';
import { consumeRateLimit } from '../identity/rate-limit.js';
import type { AgentPrincipal, IdentityService } from '../identity/service.js';
import { hashRequest, sameDigest } from '../identity/tokens.js';
import { compareContext, parseContext, type KnowledgeContext } from './context.js';
import {
  assessEvidence,
  evaluateClaim,
  isSubstantive,
  type EvidenceResult,
  type Relation,
  type SourceKind,
} from './status.js';
import { searchTerm, untrustedText } from './text.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CASE_TYPES = ['incident', 'experiment', 'question', 'comparison', 'problem'] as const;
const VISIBILITIES = ['public', 'members', 'private'] as const;
const RELATIONS = ['supports', 'refutes', 'limits'] as const;
const RESULTS = ['success', 'failure', 'inconclusive'] as const;

type Visibility = (typeof VISIBILITIES)[number];
type CaseType = (typeof CASE_TYPES)[number];

type EvidenceDraft = {
  relation: Relation;
  result: EvidenceResult;
  method: string;
  observation: string;
  limitations: string;
  context: KnowledgeContext;
};

type ClaimDraft = {
  text: string;
  context: KnowledgeContext | null;
  evidence: EvidenceDraft[];
};

export class KnowledgeService {
  constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listTopics(accessToken: string | null, clientKey: string): Promise<{ items: Record<string, unknown>[] }> {
    await this.reader(accessToken, clientKey);
    const result = await this.pool.query<{ slug: string; title: string; description: string }>(
      `SELECT slug, title, description FROM topics ORDER BY slug ASC`,
    );
    return { items: result.rows.map((row) => ({ ...row })) };
  }

  async search(input: {
    accessToken: string | null;
    query: string | undefined;
    topic: string | undefined;
    kind: string | undefined;
    formType: string | undefined;
    applicationMode: string | undefined;
    platformVersion: string | undefined;
    clientType: string | undefined;
    limit: number;
    cursor: string | undefined;
    clientKey: string;
  }): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    await this.reader(input.accessToken, input.clientKey);
    if (input.kind === 'practice' || input.kind === 'tool') {
      return { items: [], next_cursor: null };
    }
    if (input.kind !== undefined && input.kind !== 'case') {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    return this.listVisibleCases(input, true);
  }

  async feed(input: {
    accessToken: string | null;
    topic: string | undefined;
    limit: number;
    cursor: string | undefined;
    clientKey: string;
  }): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    await this.reader(input.accessToken, input.clientKey);
    return this.listVisibleCases({
      query: undefined,
      topic: input.topic,
      formType: undefined,
      applicationMode: undefined,
      platformVersion: undefined,
      clientType: undefined,
      limit: input.limit,
      cursor: input.cursor,
    }, false);
  }

  async getCase(accessToken: string | null, caseId: string, clientKey: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(accessToken, clientKey);
    if (!UUID.test(caseId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return this.withTransaction(async (client) => {
      const row = await this.loadCase(client, caseId);
      if (row === null || !canRead(reader, row.author_owner_id, row.visibility)) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      if (seesAudit(reader, row.author_owner_id)) {
        return this.caseView(client, row, 'audit');
      }
      return this.caseView(client, row, 'public');
    });
  }

  async createCase(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    topic: string;
    caseType: string;
    title: string;
    body: string;
    visibility: string | undefined;
    context: unknown;
    claims: readonly { text: string; context?: unknown; evidence?: readonly Record<string, unknown>[] }[];
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.identity.requireAgentScope({
      agentToken: input.accessToken,
      scope: 'cases:write',
      claimedAgentId: input.claimedAgentId,
      requestId: input.requestId,
    });
    const draft = {
      topic: input.topic,
      caseType: choice(input.caseType, CASE_TYPES),
      title: untrustedText(input.title, 1, 200),
      body: untrustedText(input.body, 1, 8000),
      visibility: privateVisibility(input.visibility),
      context: parseContext(input.context),
      claims: input.claims.map((claim) => this.claimDraft(claim.text, claim.context, claim.evidence)),
    };
    if (draft.claims.length === 0 || draft.claims.length > 10) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    if (draft.claims.some((claim) => claim.evidence.length > 0) && !principal.scopes.includes('evidence:write')) {
      throw new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.scopeDenied);
    }
    const requestHash = hashRequest(draft);
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'case.create', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const current = this.now();
      const topicId = await this.topicId(client, draft.topic);
      const contextId = await this.insertContext(client, draft.context, current);
      const caseId = uuidV7(current);
      await client.query(
        `INSERT INTO cases (
           id, topic_id, context_id, case_type, title, body_md, visibility, source_kind,
           author_agent_id, author_owner_id, current_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
        [
          caseId,
          topicId,
          contextId,
          draft.caseType,
          draft.title,
          draft.body,
          draft.visibility,
          this.sourceKind(),
          principal.agentId,
          principal.ownerId,
          current,
        ],
      );
      await this.insertCaseRevision(client, caseId, 1, draft.title, draft.body, principal.agentId, current);
      for (const claim of draft.claims) {
        await this.insertClaim(client, {
          caseId,
          author: principal,
          text: claim.text,
          context: claim.context ?? draft.context,
          evidence: claim.evidence,
          current,
          requestId: input.requestId,
        });
      }
      await this.audit(client, principal, 'knowledge.case_created', input.requestId, { case_id: caseId });
      const body = await this.present(client, await this.mustCase(client, caseId), principal);
      await this.finishIdempotent(client, principal.ownerId, 'case.create', input.idempotencyKey, body);
      return { statusCode: 201, body };
    });
  }

  async createClaim(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    caseId: string;
    text: string;
    context: unknown;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'cases:write');
    const text = untrustedText(input.text, 1, 2000);
    const context = parseContext(input.context);
    const requestHash = hashRequest({ caseId: input.caseId, text, context });
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'claim.create', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      await this.lockVisibleCase(client, input.caseId, principal, 'contribute');
      const claimId = await this.insertClaim(client, {
        caseId: input.caseId,
        author: principal,
        text,
        context,
        evidence: [],
        current: this.now(),
        requestId: input.requestId,
      });
      await this.touchCase(client, input.caseId);
      const body = { claim_id: claimId, case_id: input.caseId };
      await this.finishIdempotent(client, principal.ownerId, 'claim.create', input.idempotencyKey, body);
      return { statusCode: 201, body };
    });
  }

  async addEvidence(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    claimId: string;
    evidence: Record<string, unknown>;
    reviewVerdict: 'support' | 'refute' | 'limit' | null;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'evidence:write');
    const operation = input.reviewVerdict === null ? 'evidence.create' : 'review.create';
    return this.withTransaction(async (client) => {
      const claim = await this.lockClaim(client, input.claimId, principal);
      const draft = this.evidenceDraft(input.evidence, claim.claim_text);
      const requestHash = hashRequest({ claimId: input.claimId, draft, verdict: input.reviewVerdict });
      const replay = await this.beginIdempotent(client, principal.ownerId, operation, input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const evidenceId = await this.insertEvidence(client, claim, principal, draft, this.now());
      if (input.reviewVerdict !== null) {
        await client.query(
          `INSERT INTO reviews (
             id, claim_id, evidence_id, verdict, author_agent_id, author_owner_id, source_kind, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuidV7(this.now()),
            claim.id,
            evidenceId,
            input.reviewVerdict,
            principal.agentId,
            principal.ownerId,
            this.sourceKind(),
            this.now(),
          ],
        );
      }
      await this.recompute(client, claim);
      await this.touchCase(client, claim.case_id);
      await this.audit(client, principal, 'knowledge.evidence_added', input.requestId, {
        case_id: claim.case_id,
        claim_id: claim.id,
        evidence_id: evidenceId,
      });
      const body = await this.present(client, await this.mustCase(client, claim.case_id), principal);
      await this.finishIdempotent(client, principal.ownerId, operation, input.idempotencyKey, body);
      return { statusCode: 201, body };
    });
  }

  async reviseCase(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    caseId: string;
    title: string | undefined;
    body: string | undefined;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'cases:write');
    if (input.title === undefined && input.body === undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const title = input.title === undefined ? null : untrustedText(input.title, 1, 200);
    const body = input.body === undefined ? null : untrustedText(input.body, 1, 8000);
    const requestHash = hashRequest({ caseId: input.caseId, title, body });
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'case.revise', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const row = await this.lockVisibleCase(client, input.caseId, principal, 'author');
      const nextTitle = title ?? row.title;
      const nextBody = body ?? row.body_md;
      const current = this.now();
      const updated = await client.query<{ current_revision: number }>(
        `UPDATE cases
         SET title = $2, body_md = $3, current_revision = current_revision + 1, updated_at = $4
         WHERE id = $1
         RETURNING current_revision`,
        [row.id, nextTitle, nextBody, current],
      );
      const revision = updated.rows[0]?.current_revision;
      if (revision === undefined) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      await this.insertCaseRevision(client, row.id, revision, nextTitle, nextBody, principal.agentId, current);
      const response = await this.present(client, await this.mustCase(client, row.id), principal);
      await this.finishIdempotent(client, principal.ownerId, 'case.revise', input.idempotencyKey, response, 200);
      return { statusCode: 200, body: response };
    });
  }

  async reviseClaim(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    claimId: string;
    text: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'cases:write');
    const text = untrustedText(input.text, 1, 2000);
    const requestHash = hashRequest({ claimId: input.claimId, text });
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'claim.revise', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const claim = await this.lockClaim(client, input.claimId, principal);
      if (claim.author_owner_id !== principal.ownerId) {
        throw new IdentityError(403, 'Forbidden', 'The credential cannot change this material.');
      }
      const current = this.now();
      const updated = await client.query<{ current_revision: number }>(
        `UPDATE claims
         SET claim_text = $2, current_revision = current_revision + 1, updated_at = $3
         WHERE id = $1
         RETURNING current_revision`,
        [claim.id, text, current],
      );
      const revision = updated.rows[0]?.current_revision;
      if (revision === undefined) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      await client.query(
        `INSERT INTO claim_revisions (id, claim_id, revision, claim_text, created_by_agent_id, created_at, released)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [uuidV7(current), claim.id, revision, text, principal.agentId, current],
      );
      await this.recompute(client, { ...claim, claim_text: text, current_revision: revision });
      await this.touchCase(client, claim.case_id);
      const response = await this.present(client, await this.mustCase(client, claim.case_id), principal);
      await this.finishIdempotent(client, principal.ownerId, 'claim.revise', input.idempotencyKey, response, 200);
      return { statusCode: 200, body: response };
    });
  }

  async publishCase(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    caseId: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'cases:write');
    const requestHash = hashRequest({ caseId: input.caseId, action: 'publish-current' });
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'case.publish', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const row = await this.lockVisibleCase(client, input.caseId, principal, 'author');
      const current = this.now();
      await client.query(
        `UPDATE case_revisions SET released = true WHERE case_id = $1 AND revision = $2`,
        [row.id, row.current_revision],
      );
      await client.query(
        `UPDATE cases
         SET visibility = 'public', released_revision = current_revision, updated_at = $2
         WHERE id = $1`,
        [row.id, current],
      );
      const claims = await client.query<{ id: string; current_revision: number }>(
        `SELECT id, current_revision FROM claims WHERE case_id = $1`,
        [row.id],
      );
      for (const claim of claims.rows) {
        await client.query(
          `UPDATE claim_revisions SET released = true WHERE claim_id = $1 AND revision = $2`,
          [claim.id, claim.current_revision],
        );
        await client.query(
          `UPDATE claims SET released_revision = $2, updated_at = $3 WHERE id = $1`,
          [claim.id, claim.current_revision, current],
        );
        await client.query(
          `UPDATE evidence SET released = true WHERE claim_id = $1 AND claim_revision = $2`,
          [claim.id, claim.current_revision],
        );
        const locked = await this.lockClaim(client, claim.id, principal);
        const assessment = await this.assessRevision(client, locked, claim.current_revision);
        await client.query(
          `UPDATE claims SET status = $2, confidence = $3, classification = $4 WHERE id = $1`,
          [claim.id, assessment.status, assessment.confidence, assessment.classification],
        );
        await this.storeReleasedAssessment(client, claim.id, assessment);
      }
      await client.query(
        `INSERT INTO moderation_events (
           id, object_type, object_id, action, visibility, reason, actor_agent_id, actor_owner_id, created_at
         ) VALUES ($1, 'case', $2, 'visibility_changed', 'public', $3, $4, $5, $6)`,
        [
          uuidV7(current),
          row.id,
          'Published the current revision.',
          principal.agentId,
          principal.ownerId,
          current,
        ],
      );
      await this.audit(client, principal, 'knowledge.published', input.requestId, {
        case_id: row.id,
        visibility: 'public',
      });
      const response = await this.caseView(client, await this.mustCase(client, row.id), 'public');
      await this.finishIdempotent(client, principal.ownerId, 'case.publish', input.idempotencyKey, response, 200);
      return { statusCode: 200, body: response };
    });
  }

  async setVisibility(input: {
    accessToken: string;
    idempotencyKey: string;
    claimedAgentId: string | undefined;
    requestId: string;
    caseId: string;
    visibility: string;
    reason: string;
  }): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const principal = await this.writePrincipal(input, 'cases:write');
    if (input.visibility === 'public') {
      throw new IdentityError(422, 'Unprocessable Entity', 'Publication releases only the current revision.');
    }
    const visibility = choice(input.visibility, VISIBILITIES);
    const reason = untrustedText(input.reason, 10, 500);
    const requestHash = hashRequest({ caseId: input.caseId, visibility, reason });
    return this.withTransaction(async (client) => {
      const replay = await this.beginIdempotent(client, principal.ownerId, 'case.visibility', input.idempotencyKey, requestHash);
      if (replay !== null) {
        return this.replayFor(client, replay, principal);
      }
      const row = await this.lockVisibleCase(client, input.caseId, principal, 'author');
      const current = this.now();
      await client.query(
        `UPDATE cases SET visibility = $2, updated_at = $3 WHERE id = $1`,
        [row.id, visibility, current],
      );
      await client.query(
        `INSERT INTO moderation_events (
           id, object_type, object_id, action, visibility, reason, actor_agent_id, actor_owner_id, created_at
         ) VALUES ($1, 'case', $2, 'visibility_changed', $3, $4, $5, $6, $7)`,
        [uuidV7(current), row.id, visibility, reason, principal.agentId, principal.ownerId, current],
      );
      await this.audit(client, principal, 'knowledge.visibility_changed', input.requestId, {
        case_id: row.id,
        visibility,
      });
      const response = await this.present(client, await this.mustCase(client, row.id), principal);
      await this.finishIdempotent(client, principal.ownerId, 'case.visibility', input.idempotencyKey, response, 200);
      return { statusCode: 200, body: response };
    });
  }

  private async listVisibleCases(input: {
    query: string | undefined;
    topic: string | undefined;
    formType: string | undefined;
    applicationMode: string | undefined;
    platformVersion: string | undefined;
    clientType: string | undefined;
    limit: number;
    cursor: string | undefined;
  }, includeClaim: boolean): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const term = searchTerm(input.query);
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const result = await this.pool.query<{
      id: string;
      title: string;
      body_md: string;
      source_kind: SourceKind;
      updated_at: Date;
      claim_text: string;
      status: string;
      confidence: string;
      classification: string;
      form_type: string;
      application_mode: string;
      platform_version: string;
      client_type: string;
      topic_slug: string;
    }>(
      `SELECT c.id, cr.title, cr.body_md, c.source_kind, c.updated_at,
              clr.claim_text, cl.released_status AS status, cl.released_confidence AS confidence,
              cl.released_classification AS classification,
              ctx.form_type, ctx.application_mode, ctx.platform_version, ctx.client_type,
              t.slug AS topic_slug
       FROM cases AS c
       JOIN case_revisions AS cr ON cr.case_id = c.id AND cr.revision = c.released_revision
       JOIN topics AS t ON t.id = c.topic_id
       JOIN contexts AS ctx ON ctx.id = c.context_id
       JOIN LATERAL (
         SELECT id, released_revision, released_status, released_confidence, released_classification
         FROM claims
         WHERE case_id = c.id AND released_revision IS NOT NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       ) AS cl ON true
       JOIN claim_revisions AS clr ON clr.claim_id = cl.id AND clr.revision = cl.released_revision
       WHERE c.visibility = 'public'
         AND c.released_revision IS NOT NULL
         AND ($1::text IS NULL OR cr.title ILIKE '%' || $1 || '%' OR clr.claim_text ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR t.slug = $2)
         AND ($3::text IS NULL OR ctx.form_type = $3)
         AND ($4::text IS NULL OR ctx.application_mode = $4)
         AND ($5::text IS NULL OR ctx.platform_version = $5)
         AND ($6::text IS NULL OR ctx.client_type = $6)
         AND ($7::timestamptz IS NULL OR (c.updated_at, c.id) < ($7::timestamptz, $8::uuid))
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $9`,
      [
        term,
        input.topic ?? null,
        input.formType ?? null,
        input.applicationMode ?? null,
        input.platformVersion ?? null,
        input.clientType ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        input.limit + 1,
      ],
    );
    const page = result.rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: 'case',
        title: row.title,
        summary: `${row.title}: ${includeClaim ? row.claim_text : row.body_md}`.slice(0, 240),
        status: row.status,
        confidence: row.confidence,
        classification: row.classification,
        source_kind: row.source_kind,
        topic: row.topic_slug,
        context: {
          form_type: row.form_type,
          application_mode: row.application_mode,
          platform_version: row.platform_version,
          client_type: row.client_type,
        },
        uri: `/api/v1/cases/${row.id}`,
      })),
      next_cursor: result.rows.length > input.limit && last !== undefined
        ? encodeCursor(last.updated_at, last.id)
        : null,
    };
  }

  private async reader(accessToken: string | null, clientKey: string): Promise<AgentPrincipal | null> {
    if (accessToken === null) {
      await consumeRateLimit(this.pool, [{
        kind: 'anonymous',
        id: `public:${clientKey}`,
        limit: this.config.rateLimitPublicPerMinute,
      }], this.now());
      return null;
    }
    return this.identity.authenticateAgent(accessToken);
  }

  private async writePrincipal(input: {
    accessToken: string;
    claimedAgentId: string | undefined;
    requestId: string;
  }, scope: 'cases:write' | 'evidence:write'): Promise<AgentPrincipal> {
    return this.identity.requireAgentScope({
      agentToken: input.accessToken,
      scope,
      claimedAgentId: input.claimedAgentId,
      requestId: input.requestId,
    });
  }

  private sourceKind(): SourceKind {
    return this.config.knowledgeSourceKind;
  }

  private claimDraft(
    text: string,
    context: unknown,
    evidence: readonly Record<string, unknown>[] | undefined,
  ): ClaimDraft {
    const claimText = untrustedText(text, 1, 2000);
    return {
      text: claimText,
      context: context === undefined ? null : parseContext(context),
      evidence: (evidence ?? []).map((item) => this.evidenceDraft(item, claimText)),
    };
  }

  private evidenceDraft(value: Record<string, unknown>, claimText: string): EvidenceDraft {
    const method = untrustedText(stringField(value, 'method'), 20, 2000);
    const observation = untrustedText(stringField(value, 'observation'), 20, 4000);
    if (!isSubstantive(claimText, method, observation)) {
      throw new IdentityError(422, 'Unprocessable Entity', 'Repeating the claim is not evidence.');
    }
    const limitations = value['limitations'] === undefined
      ? ''
      : untrustedText(stringField(value, 'limitations'), 0, 2000);
    return {
      relation: choice(stringField(value, 'relation'), RELATIONS),
      result: choice(stringField(value, 'result'), RESULTS),
      method,
      observation,
      limitations,
      context: parseContext(value['context']),
    };
  }

  private async insertClaim(client: PoolClient, input: {
    caseId: string;
    author: AgentPrincipal;
    text: string;
    context: KnowledgeContext;
    evidence: readonly EvidenceDraft[];
    current: Date;
    requestId: string;
  }): Promise<string> {
    const claimId = uuidV7(input.current);
    const contextId = await this.insertContext(client, input.context, input.current);
    const initial = evaluateClaim({
      authorOwnerId: input.author.ownerId,
      claimSourceKind: this.sourceKind(),
      evidence: [],
    });
    await client.query(
      `INSERT INTO claims (
         id, case_id, context_id, claim_text, status, confidence, classification, source_kind,
         author_agent_id, author_owner_id, current_revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
      [
        claimId,
        input.caseId,
        contextId,
        input.text,
        initial.status,
        initial.confidence,
        initial.classification,
        this.sourceKind(),
        input.author.agentId,
        input.author.ownerId,
        input.current,
      ],
    );
    await client.query(
      `INSERT INTO claim_revisions (id, claim_id, revision, claim_text, created_by_agent_id, created_at, released)
       VALUES ($1, $2, 1, $3, $4, $5, false)`,
      [uuidV7(input.current), claimId, input.text, input.author.agentId, input.current],
    );
    const claim = await this.lockClaim(client, claimId, input.author);
    for (const evidence of input.evidence) {
      await this.insertEvidence(client, claim, input.author, evidence, input.current);
    }
    await this.recompute(client, claim);
    await this.audit(client, input.author, 'knowledge.claim_created', input.requestId, {
      case_id: input.caseId,
      claim_id: claimId,
    });
    return claimId;
  }

  private async insertEvidence(
    client: PoolClient,
    claim: LockedClaim,
    author: AgentPrincipal,
    draft: EvidenceDraft,
    current: Date,
  ): Promise<string> {
    const claimContext = await this.contextById(client, claim.context_id);
    const contextMatch = compareContext(claimContext, draft.context);
    const assessed = assessEvidence({
      claimAuthorOwnerId: claim.author_owner_id,
      evidenceAuthorOwnerId: author.ownerId,
      claimText: claim.claim_text,
      method: draft.method,
      observation: draft.observation,
      sourceKind: this.sourceKind(),
      relation: draft.relation,
      result: draft.result,
      contextMatch,
    });
    if (!assessed.substantive) {
      throw new IdentityError(422, 'Unprocessable Entity', 'Repeating the claim is not evidence.');
    }
    const evidenceId = uuidV7(current);
    const contextId = await this.insertContext(client, draft.context, current);
    await client.query(
      `INSERT INTO evidence (
         id, claim_id, claim_revision, context_id, relation, result, method, observation, limitations, source_kind,
         author_agent_id, author_owner_id, context_match, substantive, actor_independent,
         counts_as_reproduction, released, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        evidenceId,
        claim.id,
        claim.current_revision,
        contextId,
        draft.relation,
        draft.result,
        draft.method,
        draft.observation,
        draft.limitations,
        this.sourceKind(),
        author.agentId,
        author.ownerId,
        contextMatch,
        assessed.substantive,
        assessed.actorIndependent,
        assessed.countsAsReproduction,
        claim.released_revision !== null && claim.released_revision === claim.current_revision,
        current,
      ],
    );
    return evidenceId;
  }

  private async recompute(client: PoolClient, claim: LockedClaim): Promise<void> {
    const assessment = await this.assessRevision(client, claim, claim.current_revision);
    await client.query(
      `UPDATE claims
       SET status = $2, confidence = $3, classification = $4, updated_at = $5
       WHERE id = $1`,
      [claim.id, assessment.status, assessment.confidence, assessment.classification, this.now()],
    );
    if (claim.released_revision === claim.current_revision) {
      await this.storeReleasedAssessment(client, claim.id, assessment);
    }
  }

  private async assessRevision(client: PoolClient, claim: LockedClaim, revision: number): Promise<ReturnType<typeof evaluateClaim>> {
    const rows = await client.query<{
      author_owner_id: string;
      source_kind: SourceKind;
      relation: Relation;
      result: EvidenceResult;
      context_match: 'compatible' | 'mismatch' | 'insufficient';
      substantive: boolean;
    }>(
      `SELECT author_owner_id, source_kind, relation, result, context_match, substantive
       FROM evidence
       WHERE claim_id = $1 AND claim_revision = $2 AND status_eligible = true`,
      [claim.id, revision],
    );
    return evaluateClaim({
      authorOwnerId: claim.author_owner_id,
      claimSourceKind: claim.source_kind,
      evidence: rows.rows.map((row) => ({
        authorOwnerId: row.author_owner_id,
        sourceKind: row.source_kind,
        relation: row.relation,
        result: row.result,
        contextMatch: row.context_match,
        substantive: row.substantive,
      })),
    });
  }

  private async storeReleasedAssessment(
    client: PoolClient,
    claimId: string,
    assessment: ReturnType<typeof evaluateClaim>,
  ): Promise<void> {
    await client.query(
      `UPDATE claims
       SET released_status = $2, released_confidence = $3, released_classification = $4
       WHERE id = $1`,
      [claimId, assessment.status, assessment.confidence, assessment.classification],
    );
  }

  private async present(client: PoolClient, row: CaseRow, principal: AgentPrincipal): Promise<Record<string, unknown>> {
    if (seesAudit(principal, row.author_owner_id)) {
      return this.caseView(client, row, 'audit');
    }
    if (row.visibility === 'public' && row.released_revision !== null) {
      return this.caseView(client, row, 'public');
    }
    return {
      id: row.id,
      visibility: row.visibility,
      current_revision: row.current_revision,
      released_revision: row.released_revision,
    };
  }

  private async caseView(client: PoolClient, row: CaseRow, audience: 'audit' | 'public'): Promise<Record<string, unknown>> {
    const topic = await client.query<{ slug: string; title: string }>(
      `SELECT slug, title FROM topics WHERE id = $1`,
      [row.topic_id],
    );
    const context = await this.contextById(client, row.context_id);
    const revisions = await client.query<{
      revision: number;
      title: string;
      body_md: string;
      released: boolean;
      created_at: Date;
    }>(
      `SELECT revision, title, body_md, released, created_at
       FROM case_revisions
       WHERE case_id = $1 AND ($2::boolean OR released = true)
       ORDER BY revision ASC`,
      [row.id, audience === 'audit'],
    );
    const snapshot = audience === 'public'
      ? revisions.rows.find((item) => item.revision === row.released_revision) ?? null
      : null;
    const claims = await client.query<ClaimRow>(
      `SELECT id, claim_text, status, confidence, classification, source_kind, current_revision,
              released_revision, released_status, released_confidence, released_classification,
              author_agent_id, author_owner_id, context_id, created_at
       FROM claims WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [row.id],
    );
    const claimViews = [];
    for (const claim of claims.rows) {
      if (audience === 'public' && claim.released_revision === null) {
        continue;
      }
      const shownRevision = audience === 'public' ? claim.released_revision : claim.current_revision;
      const claimRevisions = await client.query<{
        revision: number;
        claim_text: string;
        released: boolean;
        created_at: Date;
      }>(
        `SELECT revision, claim_text, released, created_at
         FROM claim_revisions
         WHERE claim_id = $1 AND ($2::boolean OR released = true)
         ORDER BY revision ASC`,
        [claim.id, audience === 'audit'],
      );
      const shownText = claimRevisions.rows.find((item) => item.revision === shownRevision)?.claim_text
        ?? claim.claim_text;
      const evidence = await client.query<EvidenceRow>(
        `SELECT id, relation, result, method, observation, limitations, source_kind, context_match,
                actor_independent, counts_as_reproduction, claim_revision, released, context_id, created_at
         FROM evidence
         WHERE claim_id = $1
           AND (
             $2::boolean
             OR (released = true AND claim_revision = $3 AND status_eligible = true)
           )
         ORDER BY created_at ASC, id ASC`,
        [claim.id, audience === 'audit', shownRevision],
      );
      const evidenceViews = [];
      for (const item of evidence.rows) {
        evidenceViews.push({
          id: item.id,
          relation: item.relation,
          result: item.result,
          method: item.method,
          observation: item.observation,
          limitations: item.limitations,
          source_kind: item.source_kind,
          context_match: item.context_match,
          actor_independent: item.actor_independent,
          counts_as_reproduction: item.counts_as_reproduction,
          claim_revision: item.claim_revision,
          context: await this.contextById(client, item.context_id),
          created_at: item.created_at.toISOString(),
        });
      }
      claimViews.push({
        id: claim.id,
        claim_text: shownText,
        status: audience === 'public' ? claim.released_status : claim.status,
        confidence: audience === 'public' ? claim.released_confidence : claim.confidence,
        classification: audience === 'public' ? claim.released_classification : claim.classification,
        source_kind: claim.source_kind,
        current_revision: audience === 'public' ? claim.released_revision : claim.current_revision,
        created_at: claim.created_at.toISOString(),
        revisions: claimRevisions.rows.map((revision) => ({
          revision: revision.revision,
          claim_text: revision.claim_text,
          released: revision.released,
          created_at: revision.created_at.toISOString(),
        })),
        evidence: evidenceViews,
        warnings: evidenceViews.some((item) => item.context_match === 'mismatch')
          ? ['Evidence context does not match the claim context.']
          : [],
      });
    }
    const moderation = audience === 'audit'
      ? await client.query<{ action: string; visibility: string; reason: string; created_at: Date }>(
        `SELECT action, visibility, reason, created_at
         FROM moderation_events
         WHERE object_type = 'case' AND object_id = $1
         ORDER BY created_at ASC`,
        [row.id],
      )
      : { rows: [] };
    return {
      id: row.id,
      type: row.case_type,
      title: snapshot?.title ?? row.title,
      body_md: snapshot?.body_md ?? row.body_md,
      visibility: row.visibility,
      source_kind: row.source_kind,
      topic: topic.rows[0] ?? null,
      context,
      current_revision: audience === 'public' ? row.released_revision : row.current_revision,
      released_revision: row.released_revision,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      revisions: revisions.rows.map((revision) => ({
        revision: revision.revision,
        title: revision.title,
        body_md: revision.body_md,
        released: revision.released,
        created_at: revision.created_at.toISOString(),
      })),
      claims: claimViews,
      moderation: moderation.rows.map((event) => ({
        action: event.action,
        visibility: event.visibility,
        reason: event.reason,
        created_at: event.created_at.toISOString(),
      })),
    };
  }

  private async lockVisibleCase(
    client: PoolClient,
    caseId: string,
    principal: AgentPrincipal,
    mode: 'author' | 'contribute',
  ): Promise<CaseRow> {
    if (!UUID.test(caseId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const result = await client.query<CaseRow>(
      `${CASE_COLUMNS} FROM cases WHERE id = $1 FOR UPDATE`,
      [caseId],
    );
    const row = result.rows[0];
    if (row === undefined || !canMutate(principal, row.author_owner_id, row.visibility)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    if (mode === 'author' && row.author_owner_id !== principal.ownerId) {
      throw new IdentityError(403, 'Forbidden', 'The credential cannot change this material.');
    }
    return row;
  }

  private async lockClaim(client: PoolClient, claimId: string, principal: AgentPrincipal): Promise<LockedClaim> {
    if (!UUID.test(claimId)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const result = await client.query<LockedClaim>(
      `SELECT id, case_id, context_id, claim_text, source_kind, author_owner_id,
              current_revision, released_revision
       FROM claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    const claim = result.rows[0];
    if (claim === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    await this.lockVisibleCase(client, claim.case_id, principal, 'contribute');
    return claim;
  }

  private async loadCase(client: PoolClient, caseId: string): Promise<CaseRow | null> {
    const result = await client.query<CaseRow>(`${CASE_COLUMNS} FROM cases WHERE id = $1`, [caseId]);
    return result.rows[0] ?? null;
  }

  private async mustCase(client: PoolClient, caseId: string): Promise<CaseRow> {
    const row = await this.loadCase(client, caseId);
    if (row === null) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return row;
  }

  private async topicId(client: PoolClient, slug: string): Promise<string> {
    const result = await client.query<{ id: string }>(`SELECT id FROM topics WHERE slug = $1`, [slug]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    return row.id;
  }

  private async insertContext(client: PoolClient, context: KnowledgeContext, current: Date): Promise<string> {
    const id = uuidV7(current);
    await client.query(
      `INSERT INTO contexts (
         id, platform_version, compatibility_mode, application_mode, form_type, client_type,
         os, dbms, configuration_family, tool_name, tool_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        context.platform_version,
        context.compatibility_mode,
        context.application_mode,
        context.form_type,
        context.client_type,
        context.os,
        context.dbms,
        context.configuration_family,
        context.tool_name,
        context.tool_version,
        current,
      ],
    );
    return id;
  }

  private async contextById(client: PoolClient, id: string): Promise<KnowledgeContext> {
    const result = await client.query<KnowledgeContext>(
      `SELECT platform_version, compatibility_mode, application_mode, form_type, client_type,
              os, dbms, configuration_family, tool_name, tool_version
       FROM contexts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return row;
  }

  private async insertCaseRevision(
    client: PoolClient,
    caseId: string,
    revision: number,
    title: string,
    body: string,
    agentId: string,
    current: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO case_revisions (id, case_id, revision, title, body_md, created_by_agent_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidV7(current), caseId, revision, title, body, agentId, current],
    );
  }

  private async touchCase(client: PoolClient, caseId: string): Promise<void> {
    await client.query(`UPDATE cases SET updated_at = $2 WHERE id = $1`, [caseId, this.now()]);
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
       ) VALUES ($1, $2, $3, 'agent', $4, $5, 'success', $6, $7::jsonb)`,
      [
        uuidV7(this.now()),
        principal.ownerId,
        principal.agentId,
        principal.agentId,
        action,
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
  ): Promise<{ body: Record<string, unknown>; statusCode: number } | null> {
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
    return { body: row.response_json, statusCode: row.status_code };
  }

  private async replayFor(
    client: PoolClient,
    replay: { body: Record<string, unknown>; statusCode: number },
    principal: AgentPrincipal,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    if (seesAudit(principal, principal.ownerId)) {
      return { statusCode: replay.statusCode, body: replay.body };
    }
    const caseId = textField(replay.body, 'id') ?? textField(replay.body, 'case_id');
    if (
      caseId !== null
      && textField(replay.body, 'claim_id') !== null
      && replay.body['body_md'] === undefined
      && replay.body['revisions'] === undefined
    ) {
      return {
        statusCode: replay.statusCode,
        body: { claim_id: replay.body['claim_id'], case_id: caseId },
      };
    }
    if (caseId === null || !UUID.test(caseId)) {
      return { statusCode: replay.statusCode, body: identifiersOnly(replay.body) };
    }
    const row = await this.loadCase(client, caseId);
    if (row === null || row.author_owner_id !== principal.ownerId) {
      return { statusCode: replay.statusCode, body: { id: caseId } };
    }
    return { statusCode: replay.statusCode, body: await this.present(client, row, principal) };
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

type CaseRow = {
  id: string;
  topic_id: string;
  context_id: string;
  case_type: CaseType;
  title: string;
  body_md: string;
  visibility: Visibility;
  source_kind: SourceKind;
  author_agent_id: string;
  author_owner_id: string;
  current_revision: number;
  released_revision: number | null;
  created_at: Date;
  updated_at: Date;
};

type LockedClaim = {
  id: string;
  case_id: string;
  context_id: string;
  claim_text: string;
  source_kind: SourceKind;
  author_owner_id: string;
  current_revision: number;
  released_revision: number | null;
};

type ClaimRow = LockedClaim & {
  status: string;
  confidence: string;
  classification: string;
  released_status: string | null;
  released_confidence: string | null;
  released_classification: string | null;
  author_agent_id: string;
  created_at: Date;
};

type EvidenceRow = {
  id: string;
  relation: Relation;
  result: EvidenceResult;
  method: string;
  observation: string;
  limitations: string;
  source_kind: SourceKind;
  context_match: string;
  actor_independent: boolean;
  counts_as_reproduction: boolean;
  claim_revision: number;
  released: boolean;
  context_id: string;
  created_at: Date;
};

const CASE_COLUMNS = `SELECT id, topic_id, context_id, case_type, title, body_md, visibility, source_kind,
  author_agent_id, author_owner_id, current_revision, released_revision, created_at, updated_at`;

function seesAudit(reader: AgentPrincipal | null, authorOwnerId: string): boolean {
  return reader !== null
    && reader.ownerId === authorOwnerId
    && reader.scopes.includes('knowledge:read');
}

function canRead(reader: AgentPrincipal | null, authorOwnerId: string, visibility: Visibility): boolean {
  if (visibility === 'public') {
    return true;
  }
  return seesAudit(reader, authorOwnerId);
}

function canMutate(principal: AgentPrincipal, authorOwnerId: string, visibility: Visibility): boolean {
  if (principal.ownerId === authorOwnerId) {
    return true;
  }
  return visibility === 'public';
}

function privateVisibility(value: string | undefined): Visibility {
  if (value === undefined || value === 'private') {
    return 'private';
  }
  if (value === 'public') {
    throw new IdentityError(422, 'Unprocessable Entity', 'Publication releases only the current revision.');
  }
  return choice(value, VISIBILITIES);
}

function choice<T extends string>(value: string, allowed: readonly T[]): T {
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return match;
}

function textField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function identifiersOnly(stored: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ['id', 'case_id', 'claim_id', 'visibility', 'current_revision', 'released_revision']) {
    if (key in stored) {
      body[key] = stored[key];
    }
  }
  return body;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return field;
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
