import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { consumeRateLimit } from '../identity/rate-limit.js';
import type { IdentityService } from '../identity/service.js';
import { matchProfile, type ApplicabilitySpec, type MatchQuery } from './match.js';
import { assertSafeHttpsUrl } from './urls.js';

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const IDENTIFIER = /^[a-z0-9-]{1,80}$/;

type ProfileRow = {
  profile_id: string;
  version: string;
  status: string;
  source_kind: string;
  summary: string;
  tasks: unknown;
  hosts: unknown;
  applicability: ApplicabilitySpec;
  incompatibilities: unknown;
  components: unknown;
  verification_steps: unknown;
  rollback_steps: unknown;
  source_uris: unknown;
  limitations: unknown;
  alternatives: unknown;
  evidence_quality: string;
  recommendation_level: string;
  conflicts_of_interest: string;
  independent_owner_confirmations: number;
  last_reviewed_at: Date | null;
  review_due_at: Date | null;
  created_at: Date;
};

type ComponentRow = {
  component_id: string;
  version: string;
  status: string;
  source_kind: string;
  summary: string;
  hosts: unknown;
  requirements: unknown;
  limitations: unknown;
  risks: unknown;
  provenance: unknown;
  mcp: unknown;
  sha256: string | null;
  evidence_quality: string;
  independent_owner_confirmations: number;
  last_reviewed_at: Date | null;
  created_at: Date;
  kind: string;
  name: string;
  purpose: string;
  maintainer: string;
  upstream_url: string;
  license: string;
};

export class EnvironmentService {
  constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listProfiles(input: {
    accessToken: string | null;
    clientKey: string;
    limit: number;
    includeWithdrawn: boolean;
  }): Promise<{ items: Record<string, unknown>[]; next_cursor: null }> {
    await this.reader(input.accessToken, input.clientKey);
    const limit = boundLimit(input.limit);
    const result = await this.pool.query<ProfileRow>(
      `${PROFILE_SELECT}
       WHERE ($1::boolean OR status <> 'withdrawn')
       ORDER BY profile_id ASC, version DESC
       LIMIT $2`,
      [input.includeWithdrawn, limit],
    );
    return { items: result.rows.map(profileView), next_cursor: null };
  }

  async getProfile(input: {
    accessToken: string | null;
    clientKey: string;
    profileId: string;
    version: string | undefined;
  }): Promise<Record<string, unknown>> {
    await this.reader(input.accessToken, input.clientKey);
    if (!IDENTIFIER.test(input.profileId) || (input.version !== undefined && !VERSION.test(input.version))) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const row = input.version === undefined
      ? await this.headProfile(input.profileId)
      : await this.profileVersion(input.profileId, input.version);
    if (row === null) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const events = await this.events('profile', row.profile_id, row.version);
    return { ...profileView(row), events, local_match: 'Use the catalog matching rules locally. Do not upload the workspace.' };
  }

  async getComponentVersion(input: {
    accessToken: string | null;
    clientKey: string;
    componentId: string;
    version: string;
  }): Promise<Record<string, unknown>> {
    await this.reader(input.accessToken, input.clientKey);
    if (!IDENTIFIER.test(input.componentId) || !VERSION.test(input.version)) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    const result = await this.pool.query<ComponentRow>(
      `${COMPONENT_SELECT} WHERE component_id = $1 AND version = $2`,
      [input.componentId, input.version],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
    }
    return componentView(row);
  }

  async catalog(input: { accessToken: string | null; clientKey: string }): Promise<Record<string, unknown>> {
    await this.reader(input.accessToken, input.clientKey);
    const profiles = await this.pool.query<ProfileRow>(
      `${PROFILE_SELECT} ORDER BY profile_id ASC, version ASC`,
    );
    const components = await this.pool.query<ComponentRow>(
      `${COMPONENT_SELECT} ORDER BY component_id ASC, version ASC`,
    );
    const stamps = [...profiles.rows, ...components.rows].map((row) => row.created_at.getTime());
    const generatedAt = new Date(stamps.length === 0 ? this.now().getTime() : Math.max(...stamps));
    return catalogDocument(profiles.rows, components.rows, generatedAt);
  }

  match(spec: ApplicabilitySpec, query: MatchQuery) {
    return matchProfile(spec, query);
  }

  async reviseDraftSummary(profileId: string, version: string, summary: string): Promise<void> {
    if (summary.trim().length === 0 || summary.length > 4000) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const result = await this.pool.query(
      `UPDATE profile_versions
       SET summary = $3
       WHERE profile_id = $1 AND version = $2 AND status IN ('draft', 'reviewed')`,
      [profileId, version, summary],
    );
    if (result.rowCount !== 1) {
      throw new IdentityError(409, 'Conflict', 'Only a draft or reviewed profile version can be edited.');
    }
  }

  async withdrawProfile(profileId: string, version: string, reason: string): Promise<void> {
    if (reason.trim().length < 10 || reason.length > 500) {
      throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE profile_versions
         SET status = 'withdrawn'
         WHERE profile_id = $1 AND version = $2 AND status = 'published'`,
        [profileId, version],
      );
      if (updated.rowCount !== 1) {
        throw new IdentityError(409, 'Conflict', 'Only a published profile version can be withdrawn.');
      }
      await client.query(
        `INSERT INTO registry_events (id, object_type, object_id, object_version, action, reason, created_at)
         VALUES (gen_random_uuid(), 'profile', $1, $2, 'withdrawn', $3, $4)`,
        [profileId, version, reason, this.now()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async publishSynthetic(profileId: string, version: string): Promise<void> {
    await this.pool.query(
      `UPDATE profile_versions SET status = 'published' WHERE profile_id = $1 AND version = $2`,
      [profileId, version],
    );
  }

  private async reader(accessToken: string | null, clientKey: string): Promise<void> {
    if (accessToken === null) {
      await consumeRateLimit(this.pool, [{
        kind: 'anonymous',
        id: `public:${clientKey}`,
        limit: this.config.rateLimitPublicPerMinute,
      }], this.now());
      return;
    }
    await this.identity.authenticateAgent(accessToken);
  }

  private async headProfile(profileId: string): Promise<ProfileRow | null> {
    const result = await this.pool.query<ProfileRow>(
      `${PROFILE_SELECT}
       WHERE profile_id = $1 AND status <> 'withdrawn'
       ORDER BY string_to_array(version, '.')::int[] DESC
       LIMIT 1`,
      [profileId],
    );
    return result.rows[0] ?? null;
  }

  private async profileVersion(profileId: string, version: string): Promise<ProfileRow | null> {
    const result = await this.pool.query<ProfileRow>(
      `${PROFILE_SELECT} WHERE profile_id = $1 AND version = $2`,
      [profileId, version],
    );
    return result.rows[0] ?? null;
  }

  private async events(objectType: string, objectId: string, version: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<{ action: string; reason: string; created_at: Date }>(
      `SELECT action, reason, created_at
       FROM registry_events
       WHERE object_type = $1 AND object_id = $2 AND object_version = $3
       ORDER BY created_at ASC, id ASC`,
      [objectType, objectId, version],
    );
    return result.rows.map((row) => ({
      action: row.action,
      reason: row.reason,
      created_at: row.created_at.toISOString(),
    }));
  }
}

const PROFILE_COLUMNS = `profile_id, version, status, source_kind, summary, tasks, hosts, applicability,
  incompatibilities, components, verification_steps, rollback_steps, source_uris, limitations, alternatives,
  evidence_quality, recommendation_level, conflicts_of_interest, independent_owner_confirmations,
  last_reviewed_at, review_due_at, created_at`;

const PROFILE_SELECT = `SELECT ${PROFILE_COLUMNS} FROM profile_versions`;

const COMPONENT_SELECT = `SELECT v.component_id, v.version, v.status, v.source_kind, v.summary, v.hosts,
  v.requirements, v.limitations, v.risks, v.provenance, v.mcp, v.sha256, v.evidence_quality,
  v.independent_owner_confirmations, v.last_reviewed_at, v.created_at,
  c.kind, c.name, c.purpose, c.maintainer, c.upstream_url, c.license
  FROM component_versions AS v
  JOIN environment_components AS c ON c.id = v.component_id`;

function profileView(row: ProfileRow): Record<string, unknown> {
  return {
    id: row.profile_id,
    version: row.version,
    status: row.status,
    source_kind: row.source_kind,
    summary: row.summary,
    tasks: row.tasks,
    hosts: row.hosts,
    applicability: row.applicability,
    incompatibilities: row.incompatibilities,
    components: row.components,
    verification_steps: row.verification_steps,
    rollback_steps: row.rollback_steps,
    source_uris: row.source_uris,
    limitations: row.limitations,
    alternatives: row.alternatives,
    evidence_quality: row.evidence_quality,
    recommendation_level: row.recommendation_level,
    conflicts_of_interest: row.conflicts_of_interest,
    independent_owner_confirmations: row.independent_owner_confirmations,
    confirmed_practice: false,
    efficiency_ranking: null,
    immutable: row.status !== 'draft' && row.status !== 'reviewed',
    last_reviewed_at: row.last_reviewed_at?.toISOString() ?? null,
    review_due_at: row.review_due_at?.toISOString() ?? null,
    instructions_are_untrusted: true,
    owner_authorization_required: true,
  };
}

function componentView(row: ComponentRow): Record<string, unknown> {
  return {
    id: row.component_id,
    version: row.version,
    status: row.status,
    source_kind: row.source_kind,
    kind: row.kind,
    name: row.name,
    purpose: row.purpose,
    summary: row.summary,
    maintainer: row.maintainer,
    upstream_url: row.upstream_url,
    license: row.license,
    hosts: row.hosts,
    requirements: row.requirements,
    limitations: row.limitations,
    risks: row.risks,
    provenance: row.provenance,
    mcp: row.mcp,
    sha256: row.sha256,
    sha256_is_trust: false,
    evidence_quality: row.evidence_quality,
    independent_owner_confirmations: row.independent_owner_confirmations,
    efficiency_ranking: null,
    last_reviewed_at: row.last_reviewed_at?.toISOString() ?? null,
    instructions_are_untrusted: true,
  };
}

export function catalogDocument(
  profiles: readonly ProfileRow[],
  components: readonly ComponentRow[],
  now: Date,
): Record<string, unknown> {
  const body = {
    schema_version: '0.2.0',
    catalog_version: '2026.10.20-1',
    generated_at: now.toISOString(),
    source_kind: 'mixed',
    signature: {
      status: 'unsupported',
      signed: false,
      detail: 'This catalog is not cryptographically signed. A content hash is not a signature and is not a trust anchor.',
    },
    efficiency_ranking: null,
    matching: {
      location: 'local',
      upload_workspace: false,
      outcomes: ['applicable', 'inapplicable', 'partially_applicable', 'unknown'],
      unknown_is_not_confirmed: true,
    },
    profiles: profiles.map(profileView),
    tools: components.map(componentView),
  };
  const encoded = JSON.stringify(body);
  return {
    ...body,
    content_sha256: createHash('sha256').update(encoded, 'utf8').digest('hex'),
  };
}

function boundLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return value;
}

export function assertCatalogUrl(value: string): void {
  assertSafeHttpsUrl(value);
}
