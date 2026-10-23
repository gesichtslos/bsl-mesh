import type { FastifyPluginAsync } from 'fastify';

import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import { parseGrant, type WorkspaceService } from '../workspaces/service.js';
import { problemSchema } from './problem.js';

const problems = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
  429: problemSchema,
} as const;

const open = { type: 'object', additionalProperties: true } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/);
  if (match?.[1] === undefined) {
    throw new IdentityError(401, 'Unauthorized', 'Credentials are required.');
  }
  return match[1];
}

function idempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new IdentityError(422, 'Unprocessable Entity', 'Idempotency-Key is required.');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
  }
  return value as Record<string, unknown>;
}

export const workspaceRoutes: FastifyPluginAsync<{ service: WorkspaceService }> = async (app, options) => {
  app.post('/api/v1/workspaces', { schema: { body: open, response: { 200: open, 201: open, ...problems } } }, async (request, reply) => {
    const body = record(request.body);
    const result = await options.service.create({
      accessToken: bearer(request.headers.authorization),
      idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
      requestId: request.id,
      goal: body['goal'],
    });
    return reply.code(result.statusCode === 201 ? 201 : 200).send(result.body);
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => options.service.get(bearer(request.headers.authorization), request.params.workspaceId),
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/invitations',
    { schema: { body: open, response: { 200: open, 201: open, ...problems } } },
    async (request, reply) => {
      if (!UUID.test(request.params.workspaceId)) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const body = record(request.body);
      const agentId = body['agent_id'];
      if (typeof agentId !== 'string' || !UUID.test(agentId)) {
        throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
      }
      const result = await options.service.invite({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        workspaceId: request.params.workspaceId,
        agentId,
        grant: parseGrant(body['grant']),
      });
      return reply.code(result.statusCode === 201 ? 201 : 200).send(result.body);
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/membership',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => {
      if (!UUID.test(request.params.workspaceId)) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const result = await options.service.join({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        workspaceId: request.params.workspaceId,
      });
      return result.body;
    },
  );

  app.post<{ Params: { workspaceId: string; agentId: string } }>(
    '/api/v1/workspaces/:workspaceId/members/:agentId/removal',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => {
      if (!UUID.test(request.params.workspaceId) || !UUID.test(request.params.agentId)) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      const result = await options.service.remove({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        workspaceId: request.params.workspaceId,
        agentId: request.params.agentId,
      });
      return result.body;
    },
  );
};
