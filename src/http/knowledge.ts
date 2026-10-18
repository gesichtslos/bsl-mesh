import type { FastifyPluginAsync } from 'fastify';

import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { problemSchema } from './problem.js';

const problems = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
  429: problemSchema,
  500: problemSchema,
} as const;

const objectResponse = { type: 'object', additionalProperties: true } as const;
const uuidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
  },
} as const;

const contextSchema = { type: 'object', additionalProperties: true } as const;

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'result', 'method', 'observation', 'context'],
  properties: {
    relation: { type: 'string', enum: ['supports', 'refutes', 'limits'] },
    result: { type: 'string', enum: ['success', 'failure', 'inconclusive'] },
    method: { type: 'string', minLength: 20, maxLength: 2000 },
    observation: { type: 'string', minLength: 20, maxLength: 4000 },
    limitations: { type: 'string', maxLength: 2000 },
    context: contextSchema,
  },
} as const;

function bearer(header: string | string[] | undefined): string {
  if (typeof header !== 'string') {
    throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,200})$/.exec(header);
  const token = match?.[1];
  if (token === undefined) {
    throw new IdentityError(401, 'Unauthorized', IDENTITY_DETAIL.credentialsInvalid);
  }
  return token;
}

function optionalBearer(header: string | string[] | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  return bearer(header);
}

function idempotencyKey(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(header)) {
    throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
  }
  return header;
}

function claimedAgent(value: string | undefined): string | undefined {
  return value;
}

export const knowledgeRoutes: FastifyPluginAsync<{ service: KnowledgeService }> = async (app, options) => {
  const { service } = options;
  const pageQuery = {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: 200 },
      topic: { type: 'string', maxLength: 80 },
      kind: { type: 'string', enum: ['case', 'practice', 'tool'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 512 },
      'context.form_type': { type: 'string', maxLength: 40 },
      'context.application_mode': { type: 'string', maxLength: 40 },
      'context.platform_version': { type: 'string', maxLength: 40 },
      'context.client_type': { type: 'string', maxLength: 40 },
    },
  } as const;

  app.get<{ Querystring: Record<string, string | number | undefined> }>(
    '/api/v1/topics',
    { schema: { response: { 200: objectResponse, ...problems } } },
    async (request) => service.listTopics(optionalBearer(request.headers.authorization)),
  );

  app.get<{ Querystring: Record<string, string | number | undefined> }>(
    '/api/v1/search',
    { schema: { querystring: pageQuery, response: { 200: objectResponse, ...problems } } },
    async (request) => service.search({
      accessToken: optionalBearer(request.headers.authorization),
      query: stringQuery(request.query, 'q'),
      topic: stringQuery(request.query, 'topic'),
      kind: stringQuery(request.query, 'kind'),
      formType: stringQuery(request.query, 'context.form_type'),
      applicationMode: stringQuery(request.query, 'context.application_mode'),
      platformVersion: stringQuery(request.query, 'context.platform_version'),
      clientType: stringQuery(request.query, 'context.client_type'),
      limit: request.query['limit'] === undefined ? 20 : Number(request.query['limit']),
      cursor: stringQuery(request.query, 'cursor'),
    }),
  );

  app.get<{ Querystring: Record<string, string | number | undefined> }>(
    '/api/v1/feed',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: { type: 'string', maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        response: { 200: objectResponse, ...problems },
      },
    },
    async (request) => service.feed({
      accessToken: optionalBearer(request.headers.authorization),
      topic: stringQuery(request.query, 'topic'),
      limit: request.query['limit'] === undefined ? 20 : Number(request.query['limit']),
      cursor: stringQuery(request.query, 'cursor'),
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/cases/:id',
    { schema: { params: uuidParams, response: { 200: objectResponse, ...problems } } },
    async (request) => service.getCase(optionalBearer(request.headers.authorization), request.params.id),
  );

  app.post<{
    Body: {
      type: string;
      title: string;
      body_md: string;
      topic: string;
      visibility?: string;
      context: unknown;
      claims: { text: string; context?: unknown; evidence?: Record<string, unknown>[] }[];
      agent_id?: string;
    };
  }>(
    '/api/v1/cases',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'title', 'body_md', 'topic', 'context', 'claims'],
          properties: {
            type: { type: 'string', enum: ['incident', 'experiment', 'question', 'comparison', 'problem'] },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            body_md: { type: 'string', minLength: 1, maxLength: 8000 },
            topic: { type: 'string', minLength: 1, maxLength: 80 },
            visibility: { type: 'string', enum: ['public', 'members', 'private'] },
            context: contextSchema,
            claims: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: {
                  text: { type: 'string', minLength: 1, maxLength: 2000 },
                  context: contextSchema,
                  evidence: { type: 'array', maxItems: 5, items: evidenceSchema },
                },
              },
            },
            agent_id: { type: 'string' },
          },
        },
        response: { 201: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.createCase({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        topic: request.body.topic,
        caseType: request.body.type,
        title: request.body.title,
        body: request.body.body_md,
        visibility: request.body.visibility,
        context: request.body.context,
        claims: request.body.claims,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string; context: unknown; agent_id?: string } }>(
    '/api/v1/cases/:id/claims',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'context'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 2000 },
            context: contextSchema,
            agent_id: { type: 'string' },
          },
        },
        response: { 201: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.createClaim({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        caseId: request.params.id,
        text: request.body.text,
        context: request.body.context,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/claims/:id/evidence',
    {
      schema: {
        params: uuidParams,
        body: {
          ...evidenceSchema,
          properties: { ...evidenceSchema.properties, agent_id: { type: 'string' } },
        },
        response: { 201: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const agentId = request.body['agent_id'];
      const evidence = { ...request.body };
      delete evidence['agent_id'];
      const result = await service.addEvidence({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: typeof agentId === 'string' ? agentId : undefined,
        requestId: request.id,
        claimId: request.params.id,
        evidence,
        reviewVerdict: null,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      verdict: 'support' | 'refute' | 'limit';
      result: string;
      method: string;
      observation: string;
      limitations?: string;
      context: unknown;
      agent_id?: string;
    };
  }>(
    '/api/v1/claims/:id/reviews',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['verdict', 'result', 'method', 'observation', 'context'],
          properties: {
            verdict: { type: 'string', enum: ['support', 'refute', 'limit'] },
            result: { type: 'string', enum: ['success', 'failure', 'inconclusive'] },
            method: { type: 'string', minLength: 20, maxLength: 2000 },
            observation: { type: 'string', minLength: 20, maxLength: 4000 },
            limitations: { type: 'string', maxLength: 2000 },
            context: contextSchema,
            agent_id: { type: 'string' },
          },
        },
        response: { 201: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const relation = request.body.verdict === 'support'
        ? 'supports'
        : request.body.verdict === 'refute'
          ? 'refutes'
          : 'limits';
      const result = await service.addEvidence({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        claimId: request.params.id,
        reviewVerdict: request.body.verdict,
        evidence: {
          relation,
          result: request.body.result,
          method: request.body.method,
          observation: request.body.observation,
          limitations: request.body.limitations,
          context: request.body.context,
        },
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.patch<{ Params: { id: string }; Body: { title?: string; body_md?: string; agent_id?: string } }>(
    '/api/v1/cases/:id',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            body_md: { type: 'string', minLength: 1, maxLength: 8000 },
            agent_id: { type: 'string' },
          },
        },
        response: { 200: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.reviseCase({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        caseId: request.params.id,
        title: request.body.title,
        body: request.body.body_md,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.patch<{ Params: { id: string }; Body: { claim_text: string; agent_id?: string } }>(
    '/api/v1/claims/:id',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['claim_text'],
          properties: {
            claim_text: { type: 'string', minLength: 1, maxLength: 2000 },
            agent_id: { type: 'string' },
          },
        },
        response: { 200: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.reviseClaim({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        claimId: request.params.id,
        text: request.body.claim_text,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { visibility: string; reason: string; agent_id?: string } }>(
    '/api/v1/cases/:id/visibility',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['visibility', 'reason'],
          properties: {
            visibility: { type: 'string', enum: ['public', 'members', 'private'] },
            reason: { type: 'string', minLength: 10, maxLength: 500 },
            agent_id: { type: 'string' },
          },
        },
        response: { 200: objectResponse, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.setVisibility({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        claimedAgentId: claimedAgent(request.body.agent_id),
        requestId: request.id,
        caseId: request.params.id,
        visibility: request.body.visibility,
        reason: request.body.reason,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );
};

function stringQuery(query: Record<string, string | number | undefined>, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}
