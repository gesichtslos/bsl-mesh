import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { IdentityError } from './identity/errors.js';
import { IdentityService } from './identity/service.js';
import { magicLinkRoute } from './identity/provider.js';
import { capabilitiesRoutes } from './http/capabilities.js';
import { healthRoutes } from './http/health.js';
import { identityRoutes } from './http/identity.js';
import { knowledgeRoutes } from './http/knowledge.js';
import { problem } from './http/problem.js';
import { KnowledgeService } from './knowledge/service.js';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.token',
  'req.body.magic_link_token',
  'req.body.session_token',
  'authorization',
  'cookie',
  'password',
  'token',
  'magic_link_token',
  'session_token',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.token',
  '*.magic_link_token',
  '*.session_token',
];

export type BuildAppOptions = {
  logStream?: Writable;
  now?: () => Date;
};

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const shared = {
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
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
    if (error instanceof IdentityError) {
      for (const [name, value] of Object.entries(error.headers)) {
        reply.header(name, value);
      }
      request.log.error({ status: error.statusCode }, 'request failed');
      return reply
        .code(error.statusCode)
        .send(problem(error.statusCode, error.title, error.detail, request.id));
    }
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
    request.log.error({ code: error.code, status }, 'request failed');
    if (status === 400) {
      return reply.code(400).send(problem(400, 'Bad Request', 'Request failed validation.', request.id));
    }
    const title = status === 500 ? 'Internal Server Error' : 'Request Error';
    const detail = status === 500 ? 'Unexpected error.' : title;
    return reply.code(status).send(problem(status, title, detail, request.id));
  });
  const now = options.now ?? (() => new Date());
  const identity = new IdentityService(pool, config, now);
  await app.register(healthRoutes, { pool });
  await app.register(capabilitiesRoutes);
  await app.register(identityRoutes, {
    service: identity,
    magicLink: magicLinkRoute(config),
  });
  await app.register(knowledgeRoutes, {
    service: new KnowledgeService(pool, identity, config, now),
  });
  return app;
}
