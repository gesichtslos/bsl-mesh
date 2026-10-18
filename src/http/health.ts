import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';

import { problem, problemSchema } from './problem.js';

const okSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
  },
} as const;

export const healthRoutes: FastifyPluginAsync<{ pool: Pool }> = async (app, options) => {
  app.get('/health/live', { schema: { response: { 200: okSchema } } }, async () => ({
    status: 'ok' as const,
  }));

  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: okSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await options.pool.query('SELECT 1');
        return { status: 'ok' as const };
      } catch {
        return reply
          .code(503)
          .type('application/problem+json')
          .send(problem(503, 'Service Unavailable', 'Database is unavailable.', request.id));
      }
    },
  );
};
