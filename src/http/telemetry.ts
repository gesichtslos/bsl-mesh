import type { FastifyPluginAsync } from 'fastify';

import { IdentityError } from '../identity/errors.js';
import type { TelemetryService } from '../telemetry/service.js';
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
  if (value === undefined || value.length < 8 || value.length > 128) {
    throw new IdentityError(422, 'Unprocessable Entity', 'Idempotency-Key is required.');
  }
  return value;
}

export const telemetryRoutes: FastifyPluginAsync<{ service: TelemetryService }> = async (app, options) => {
  app.post(
    '/api/v1/telemetry/reports',
    { schema: { body: { type: 'object', additionalProperties: true }, response: { 201: { type: 'object', additionalProperties: true }, 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request, reply) => {
      const result = await options.service.submit({
        accessToken: bearer(request.headers.authorization),
        idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
        report: request.body,
        requestId: request.id,
      });
      const statusCode = result.statusCode === 200 ? 200 : 201;
      return reply.code(statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: { source_kind?: string } }>(
    '/api/v1/telemetry/reports',
    { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => {
      const source = request.query.source_kind;
      if (source !== undefined && source !== 'organic' && source !== 'synthetic') {
        throw new IdentityError(422, 'Unprocessable Entity', 'source_kind is organic or synthetic.');
      }
      return options.service.list({
        accessToken: bearer(request.headers.authorization),
        sourceKind: source ?? null,
      });
    },
  );

  app.get<{ Params: { reportId: string } }>(
    '/api/v1/telemetry/reports/:reportId',
    { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => options.service.get(bearer(request.headers.authorization), request.params.reportId),
  );
};
