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
import { registerMcpRoute } from './mcp/route.js';
import { EnvironmentService } from './environment/service.js';
import { starterRoutes } from './http/starter.js';
import { telemetryRoutes } from './http/telemetry.js';
import { KnowledgeService } from './knowledge/service.js';
import { TelemetryService } from './telemetry/service.js';
import { HandoffService } from './handoff/service.js';
import { handoffRoutes } from './http/handoff.js';
import { anonymousToolGuard, toolReleaseRoutes } from './http/tools.js';
import { consumeRateLimit } from './identity/rate-limit.js';
import { WorkspaceService } from './workspaces/service.js';
import { workspaceRoutes } from './http/workspaces.js';

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
  afterMcpCaseCreated?: (caseId: string) => Promise<void>;
};

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const trustProxy = config.trustProxyHops === 0
    ? false
    : (_address: string, hop: number) => hop < config.trustProxyHops;
  const shared = {
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    trustProxy,
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
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.split('?')[0] === '/mcp') {
      return payload;
    }
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
    if (request.url.split('?')[0] === '/mcp') {
      const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
      request.log.error({ code: error.code, status }, 'request failed');
      const message = status === 413
        ? 'Payload is too large.'
        : status === 400
          ? 'Parse error: the request body is not valid JSON.'
          : 'Request failed.';
      return reply.code(status).type('application/json').send({
        jsonrpc: '2.0',
        error: { code: status === 400 ? -32700 : -32000, message },
        id: null,
      });
    }
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
  const knowledge = new KnowledgeService(pool, identity, config, now);
  const environment = new EnvironmentService(pool, identity, config, now);
  const telemetry = new TelemetryService(pool, identity, now);
  const handoff = new HandoffService(pool, identity, config, now);
  const workspaces = new WorkspaceService(pool, identity, config, now);
  await app.register(healthRoutes, { pool });
  await app.register(capabilitiesRoutes, { handoffEnabled: config.handoffEnabled });
  await app.register(identityRoutes, {
    service: identity,
    magicLink: magicLinkRoute(config),
  });
  await app.register(knowledgeRoutes, { service: knowledge });
  await app.register(starterRoutes, { service: environment });
  await app.register(telemetryRoutes, { service: telemetry });
  await app.register(handoffRoutes, { service: handoff });
  await app.register(workspaceRoutes, { service: workspaces });
  await app.register(toolReleaseRoutes, {
    directory: config.toolReleaseDir,
    guard: anonymousToolGuard({
      limit: async (clientKey) => {
        await consumeRateLimit(pool, [{
          kind: 'anonymous',
          id: `public:${clientKey}`,
          limit: config.rateLimitPublicPerMinute,
        }], now());
      },
      authenticate: async (accessToken) => {
        await identity.authenticateAgent(accessToken);
      },
    }),
  });
  registerMcpRoute(app, {
    knowledge,
    environment,
    identity,
    handoff,
    pool,
    config,
    now,
    ...(options.afterMcpCaseCreated !== undefined ? { afterCaseCreated: options.afterMcpCaseCreated } : {}),
  });
  return app;
}
