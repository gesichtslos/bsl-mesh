import type { FastifyPluginAsync } from 'fastify';

import type { MagicLinkRoute } from '../identity/provider.js';
import type { IdentityService } from '../identity/service.js';
import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { WRITE_SCOPES } from '../identity/scopes.js';
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

const scopeSchema = {
  type: 'string',
  enum: [
    'profile:read',
    'knowledge:read',
    'meetups:read',
    'tools:read',
    'cases:write',
    'evidence:write',
    'meetups:write',
  ],
} as const;

const uuidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
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

function idempotencyKey(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(header)) {
    throw new IdentityError(400, 'Bad Request', IDENTITY_DETAIL.validation);
  }
  return header;
}

export const identityRoutes: FastifyPluginAsync<{
  service: IdentityService;
  magicLink: MagicLinkRoute;
}> = async (app, options) => {
  const { service } = options;

  if (options.magicLink !== 'hidden') {
    app.post<{ Body: { email: string; display_name: string } }>(
      '/api/v1/auth/magic-link',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['email', 'display_name'],
            properties: {
              email: { type: 'string', minLength: 3, maxLength: 254 },
              display_name: { type: 'string', minLength: 1, maxLength: 80 },
            },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['expires_at', 'magic_link_token'],
              properties: {
                expires_at: { type: 'string' },
                magic_link_token: { type: 'string' },
              },
            },
            ...problems,
          },
        },
      },
      async (request) => service.issueTestMagicLink({
        email: request.body.email,
        displayName: request.body.display_name,
      }),
    );

    app.post<{ Body: { token: string } }>(
      '/api/v1/auth/magic-link/consume',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['token'],
            properties: {
              token: { type: 'string', minLength: 40, maxLength: 200 },
            },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['session_token', 'expires_at', 'owner_id'],
              properties: {
                session_token: { type: 'string' },
                expires_at: { type: 'string' },
                owner_id: { type: 'string' },
              },
            },
            ...problems,
          },
        },
      },
      async (request) => service.consumeMagicLink({
        token: request.body.token,
        requestId: request.id,
      }),
    );
  }

  app.get('/api/v1/owners/me', { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } }, async (request) => {
    return service.getOwner(bearer(request.headers.authorization));
  });

  app.post<{ Body: { display_name: string; description?: string } }>(
    '/api/v1/owners/me/agents',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['display_name'],
          properties: {
            display_name: { type: 'string', minLength: 1, maxLength: 80 },
            description: { type: 'string', maxLength: 500 },
          },
        },
        response: { 201: { type: 'object', additionalProperties: true }, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.createAgent({
        sessionToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        displayName: request.body.display_name,
        description: request.body.description,
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.get('/api/v1/owners/me/agents', { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } }, async (request) => {
    return service.listAgents(bearer(request.headers.authorization));
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/owners/me/agents/:id',
    { schema: { params: uuidParams, response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => service.getAgent(bearer(request.headers.authorization), request.params.id),
  );

  app.post<{ Body: { agent_id: string; scopes?: string[]; ttl_seconds: number } }>(
    '/api/v1/owners/me/credentials',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['agent_id', 'ttl_seconds'],
          properties: {
            agent_id: { type: 'string' },
            scopes: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: scopeSchema },
            ttl_seconds: { type: 'integer', minimum: 60, maximum: 7_776_000 },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'agent_id', 'scopes', 'expires_at', 'secret_available'],
            properties: {
              id: { type: 'string' },
              agent_id: { type: 'string' },
              scopes: { type: 'array', items: scopeSchema },
              expires_at: { type: 'string' },
              secret_available: { type: 'boolean' },
              token: { type: 'string' },
            },
          },
          ...problems,
        },
      },
    },
    async (request, reply) => {
      const result = await service.createCredential({
        sessionToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        agentId: request.body.agent_id,
        scopes: request.body.scopes,
        ttlSeconds: request.body.ttl_seconds,
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.get('/api/v1/owners/me/credentials', { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } }, async (request) => {
    return service.listCredentials(bearer(request.headers.authorization));
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/owners/me/credentials/:id',
    { schema: { params: uuidParams, response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request, reply) => {
      const result = await service.revokeCredential({
        sessionToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        credentialId: request.params.id,
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { ttl_seconds: number } }>(
    '/api/v1/owners/me/credentials/:id/rotate',
    {
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ttl_seconds'],
          properties: {
            ttl_seconds: { type: 'integer', minimum: 60, maximum: 7_776_000 },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'agent_id', 'scopes', 'expires_at', 'secret_available'],
            properties: {
              id: { type: 'string' },
              agent_id: { type: 'string' },
              scopes: { type: 'array', items: scopeSchema },
              expires_at: { type: 'string' },
              secret_available: { type: 'boolean' },
              token: { type: 'string' },
            },
          },
          ...problems,
        },
      },
    },
    async (request, reply) => {
      const result = await service.rotateCredential({
        sessionToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        credentialId: request.params.id,
        ttlSeconds: request.body.ttl_seconds,
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Body: { enabled: boolean } }>(
    '/api/v1/owners/me/publication',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: { 200: { type: 'object', additionalProperties: false, required: ['publication_enabled'], properties: { publication_enabled: { type: 'boolean' } } }, ...problems },
      },
    },
    async (request, reply) => {
      const result = await service.setPublication({
        sessionToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        enabled: request.body.enabled,
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    '/api/v1/owners/me/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true }, ...problems },
      },
    },
    async (request) => service.listAudit({
      sessionToken: bearer(request.headers.authorization),
      limit: request.query.limit ?? 50,
      cursor: request.query.cursor,
    }),
  );

  app.get('/api/v1/agents/me', { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } }, async (request) => {
    return service.getAgentProfile(bearer(request.headers.authorization));
  });

  app.post<{ Body: { scope: string; agent_id?: string } }>(
    '/api/v1/access/write',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['scope'],
          properties: {
            scope: { type: 'string', enum: WRITE_SCOPES },
            agent_id: { type: 'string' },
          },
        },
        response: { 204: { type: 'null' }, ...problems },
      },
    },
    async (request, reply) => {
      await service.authorizeWrite({
        agentToken: bearer(request.headers.authorization),
        scope: request.body.scope,
        claimedAgentId: request.body.agent_id,
        requestId: request.id,
      });
      return reply.code(204).send();
    },
  );
};
