import type { FastifyPluginAsync } from 'fastify';

import { problem, problemSchema } from './problem.js';

export const API_VERSION = '0.1.0';

const capabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['api_version', 'mcp', 'features'],
  properties: {
    api_version: { type: 'string', const: API_VERSION },
    mcp: { type: 'string', enum: ['unsupported'] },
    features: {
      type: 'array',
      items: { type: 'string', enum: ['health', 'identity'] },
    },
  },
} as const;

export const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/capabilities', { schema: { response: { 200: capabilitiesSchema } } }, async () => ({
    api_version: API_VERSION,
    mcp: 'unsupported' as const,
    features: ['health', 'identity'] as const,
  }));

  app.post(
    '/api/v1/capabilities',
    { schema: { response: { 405: problemSchema } } },
    async (request, reply) => {
      return reply
        .code(405)
        .type('application/problem+json')
        .send(problem(405, 'Method Not Allowed', 'Capabilities are read-only.', request.id));
    },
  );
};
