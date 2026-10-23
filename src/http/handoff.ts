import type { FastifyPluginAsync } from 'fastify';

import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import type { HandoffService } from '../handoff/service.js';
import { parseHistoryLength, parsePageSize, parseProfile, parseSend, parseSender } from '../handoff/parse.js';
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

export const handoffRoutes: FastifyPluginAsync<{ service: HandoffService }> = async (app, options) => {
  const open = { type: 'object', additionalProperties: true } as const;

  app.post(
    '/api/v1/handoff/profile',
    { schema: { body: open, response: { 200: open, 201: open, ...problems } } },
    async (request, reply) => {
      const profile = parseProfile(request.body);
      const result = await options.service.saveProfile({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        availability: profile.availability,
        skills: profile.skills,
      });
      return reply.code(result.statusCode === 201 ? 201 : 200).send(result.body);
    },
  );

  app.post(
    '/api/v1/handoff/allowances',
    { schema: { body: open, response: { 200: open, 201: open, ...problems } } },
    async (request, reply) => {
      const result = await options.service.allowSender({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        senderAgentId: parseSender(request.body),
      });
      return reply.code(result.statusCode === 201 ? 201 : 200).send(result.body);
    },
  );

  app.get(
    '/api/v1/handoff/agents',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => options.service.listAddressable(bearer(request.headers.authorization), request.id),
  );

  app.get<{ Params: { agentId: string } }>(
    '/api/v1/handoff/agents/:agentId/card',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => {
      if (!UUID.test(request.params.agentId)) {
        throw new IdentityError(404, 'Not Found', IDENTITY_DETAIL.notFound);
      }
      return options.service.getCard(bearer(request.headers.authorization), request.id, request.params.agentId);
    },
  );

  app.post(
    '/api/v1/handoff/messages',
    { schema: { body: open, response: { 200: open, 201: open, ...problems } } },
    async (request, reply) => {
      const result = await options.service.send({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        requestId: request.id,
        draft: parseSend(request.body),
      });
      return reply.code(result.statusCode === 201 ? 201 : 200).send(result.body);
    },
  );

  app.get<{ Params: { taskId: string }; Querystring: { historyLength?: string } }>(
    '/api/v1/handoff/tasks/:taskId',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => options.service.getTask({
      accessToken: bearer(request.headers.authorization),
      requestId: request.id,
      taskId: request.params.taskId,
      historyLength: parseHistoryLength(request.query.historyLength),
    }),
  );

  app.get<{ Querystring: { contextId?: string; pageSize?: string; historyLength?: string } }>(
    '/api/v1/handoff/tasks',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => {
      const contextId = request.query.contextId;
      if (contextId !== undefined && !UUID.test(contextId)) {
        throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
      }
      return options.service.listTasks({
        accessToken: bearer(request.headers.authorization),
        requestId: request.id,
        contextId,
        pageSize: parsePageSize(request.query.pageSize),
        historyLength: parseHistoryLength(request.query.historyLength),
      });
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/handoff/tasks/:taskId/cancel',
    { schema: { response: { 200: open, ...problems } } },
    async (request) => options.service.cancel({
      accessToken: bearer(request.headers.authorization),
      idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
      requestId: request.id,
      taskId: request.params.taskId,
    }),
  );
};
