import type { FastifyPluginAsync } from 'fastify';

import { problem, problemSchema } from './problem.js';

export const API_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2026-07-28';

export function capabilityDocument() {
  return {
    api_version: API_VERSION,
    mcp: {
      protocol: MCP_PROTOCOL_VERSION,
      transport: 'streamable-http' as const,
      endpoint: '/mcp' as const,
      auth: 'bearer-credential' as const,
      oauth: 'unsupported' as const,
    },
    features: ['health', 'identity', 'knowledge', 'mcp'] as const,
  };
}

const capabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['api_version', 'mcp', 'features'],
  properties: {
    api_version: { type: 'string', const: API_VERSION },
    mcp: {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'transport', 'endpoint', 'auth', 'oauth'],
      properties: {
        protocol: { type: 'string', const: MCP_PROTOCOL_VERSION },
        transport: { type: 'string', const: 'streamable-http' },
        endpoint: { type: 'string', const: '/mcp' },
        auth: { type: 'string', const: 'bearer-credential' },
        oauth: { type: 'string', const: 'unsupported' },
      },
    },
    features: {
      type: 'array',
      items: { type: 'string', enum: ['health', 'identity', 'knowledge', 'mcp'] },
    },
  },
} as const;

export const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/capabilities', { schema: { response: { 200: capabilitiesSchema } } }, async () => (
    capabilityDocument()
  ));

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
