import type { FastifyPluginAsync } from 'fastify';

import { problem, problemSchema } from './problem.js';

export const API_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';

export function capabilityDocument(handoffEnabled = false) {
  const features = ['health', 'identity', 'knowledge', 'mcp', 'starter', 'telemetry'] as const;
  return {
    api_version: API_VERSION,
    mcp: {
      protocol: MCP_PROTOCOL_VERSION,
      legacy_protocol: MCP_LEGACY_PROTOCOL_VERSION,
      transport: 'streamable-http' as const,
      endpoint: '/mcp' as const,
      auth: 'bearer-credential' as const,
      oauth: 'unsupported' as const,
    },
    features: handoffEnabled ? [...features, 'handoff'] : [...features],
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
      required: ['protocol', 'legacy_protocol', 'transport', 'endpoint', 'auth', 'oauth'],
      properties: {
        protocol: { type: 'string', const: MCP_PROTOCOL_VERSION },
        legacy_protocol: { type: 'string', const: MCP_LEGACY_PROTOCOL_VERSION },
        transport: { type: 'string', const: 'streamable-http' },
        endpoint: { type: 'string', const: '/mcp' },
        auth: { type: 'string', const: 'bearer-credential' },
        oauth: { type: 'string', const: 'unsupported' },
      },
    },
    features: {
      type: 'array',
      items: { type: 'string', enum: ['health', 'identity', 'knowledge', 'mcp', 'starter', 'telemetry', 'handoff'] },
    },
  },
} as const;

export const capabilitiesRoutes: FastifyPluginAsync<{ handoffEnabled: boolean }> = async (app, options) => {
  app.get('/api/v1/capabilities', { schema: { response: { 200: capabilitiesSchema } } }, async () => (
    capabilityDocument(options.handoffEnabled)
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
