import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { capabilitiesRoutes } from './http/capabilities.js';
import { healthRoutes } from './http/health.js';
import { problem } from './http/problem.js';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'authorization',
  'cookie',
  'password',
  '*.authorization',
  '*.cookie',
  '*.password',
];

export type BuildAppOptions = {
  logStream?: Writable;
};

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const shared = {
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  };
  const app = options.logStream
    ? Fastify({
        ...shared,
        logger: {
          level: config.logLevel,
          redact: REDACT,
          stream: options.logStream,
        },
      })
    : Fastify({
        ...shared,
        logger: {
          level: config.logLevel,
          redact: REDACT,
        },
      });
  const pool = createPool(config.databaseUrl, (message) => {
    app.log.error({ message }, 'idle database client failed');
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) {
      reply.type('application/problem+json');
    }
    return payload;
  });
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(problem(404, 'Not Found', 'No route matches this request.', request.id));
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
    const title = status === 400 ? 'Bad Request' : status === 500 ? 'Internal Server Error' : 'Request Error';
    const detail = status === 500
      ? 'Unexpected error.'
      : error.message || title;
    request.log.error({ code: error.code, status }, 'request failed');
    return reply.code(status).send(problem(status, title, detail, request.id));
  });
  await app.register(healthRoutes, { pool });
  await app.register(capabilitiesRoutes);
  return app;
}
